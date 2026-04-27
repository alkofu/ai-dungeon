use std::{
    collections::HashMap,
    ffi::OsString,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem as _};
use tauri::{AppHandle, Emitter, State};

// ── Shell init polyglot ───────────────────────────────────────────────────────
//
// `SHELL_INIT_POLYGLOT` is the body that defines `__ai_dungeon_emit_ctx()` and
// wires it into the prompt cycle for bash and zsh. It is embedded into a
// per-session shell startup file at spawn time — never written to the PTY master
// after the shell is running.
//
// Injection mechanism:
//   • zsh  — `ShellInjection::prepare` creates a per-session tempdir, writes a
//     `.zshrc` into it, and sets `ZDOTDIR` to that tempdir in the child's
//     environment. zsh reads `$ZDOTDIR/.zshrc` as its interactive rc file; our
//     `.zshrc` restores the user's original `ZDOTDIR`, sources their real
//     `~/.zshenv` and `~/.zshrc`, then appends the polyglot. Because this all
//     happens during rc-file evaluation — before ZLE (Z Line Editor) binds the
//     keyboard — the polyglot bytes are never visible in the terminal.
//   • bash — `ShellInjection::prepare` writes a `bash-init` file to the tempdir
//     and passes `--rcfile <path>` to the `CommandBuilder`. bash reads only
//     the named file as its interactive rc; our file sources the user's real
//     `~/.bashrc` then appends the polyglot.
//   • Other shells — injection is skipped; the shell starts with no extra args
//     or env overrides. The polyglot's `$ZSH_VERSION`/`$BASH_VERSION` guards
//     ensure it no-ops in those shells anyway.
//
// The `TempDir` inside `ShellInjection` is kept alive for the lifetime of the
// session (held in `PtySessionState::Active::shell_init`) and dropped when
// `pty_kill` removes the session — which removes the tempdir from the OS temp
// directory. Best-effort cleanup: if `pty_kill` is not called (e.g. the app
// crashes), the OS may reclaim the tempdir at next reboot.
//
// Known limitation (rc-file race): a user's ~/.zshrc that does
// `precmd_functions=()` (bare assignment, not `+=`) would clobber our hook.
// The mitigation is `add-zsh-hook` on zsh (deduplication-safe, append-style)
// and `PROMPT_COMMAND` prepend on bash (safe against user appends, but not
// against outright replacement with bare assignment).
//
// The script:
//   1. Defines __ai_dungeon_emit_ctx() which emits OSC 7 (CWD) and OSC 7337
//      (git context) after every prompt.
//   2. Wires the function into the prompt cycle for bash and zsh.
//   3. Is a single newline-terminated line suitable for embedding in an rc file.
#[cfg(unix)]
const SHELL_INIT_POLYGLOT: &str = concat!(
    // Define the context-emission function.
    "__ai_dungeon_emit_ctx() {",
    // Emit OSC 7: file://hostname/cwd for the current working directory.
    // Uses ${HOST:-${HOSTNAME}}: zsh exports $HOST, bash exports $HOSTNAME.
    " printf '\\033]7;file://%s%s\\033\\\\' \"${HOST:-${HOSTNAME}}\" \"${PWD}\";",
    // Fast pre-check — exits non-zero immediately outside a git repo (traverses
    // up to first mount point). On network filesystems or very deep trees this
    // may add prompt latency.
    " if git rev-parse --git-dir >/dev/null 2>&1; then",
    // Guard: only emit OSC 7337 with payload when show-toplevel succeeds and is
    // non-empty. When inside a .git directory, --git-dir succeeds but
    // --show-toplevel may fail or return empty.
    "  repo_top=$(git rev-parse --show-toplevel 2>/dev/null);",
    "  if [ -n \"$repo_top\" ]; then",
    "   repo=$(basename \"$repo_top\");",
    "   branch=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null);",
    "   printf '\\033]7337;%s\\t%s\\033\\\\' \"$repo\" \"$branch\";",
    "  else",
    // Inside a .git directory or bare repo — emit empty payload to clear git context.
    "   printf '\\033]7337;\\033\\\\';",
    "  fi;",
    " else",
    // Not in a git repo — emit empty OSC 7337 payload to clear stale git state.
    "  printf '\\033]7337;\\033\\\\';",
    " fi",
    "}; ",
    // Wire into zsh via add-zsh-hook (deduplication-safe, append-style).
    "if [ -n \"$ZSH_VERSION\" ]; then",
    " autoload -U add-zsh-hook && add-zsh-hook precmd __ai_dungeon_emit_ctx;",
    // Wire into bash by prepending to PROMPT_COMMAND (safe against user appends).
    "elif [ -n \"$BASH_VERSION\" ]; then",
    " PROMPT_COMMAND=\"__ai_dungeon_emit_ctx${PROMPT_COMMAND:+; $PROMPT_COMMAND}\";",
    "fi\n",
);

// ── Shell-startup injection ───────────────────────────────────────────────────

/// Which shell family the spawned process belongs to.
///
/// Determined by the basename of the shell path passed to `pty_spawn`. Only
/// `zsh` and `bash` receive injection; all other shells are `Other`.
#[derive(Debug, PartialEq)]
enum ShellKind {
    Zsh,
    Bash,
    Other,
}

impl ShellKind {
    /// Classify a shell path by its basename. Case-sensitive (matches macOS and
    /// Linux conventions where shell binaries are always lowercase).
    fn from_shell_path(shell: &str) -> Self {
        match std::path::Path::new(shell)
            .file_name()
            .and_then(|n| n.to_str())
        {
            Some("zsh") => ShellKind::Zsh,
            Some("bash") => ShellKind::Bash,
            _ => ShellKind::Other,
        }
    }
}

/// Per-session shell-startup injection state.
///
/// Owns a `TempDir` that is kept alive for the session lifetime. When this
/// struct is dropped (i.e. when `PtySessionState::Active` is dropped at
/// `pty_kill` time), the `TempDir` is removed from the filesystem.
///
/// `extra_args` and `extra_env` are applied to `CommandBuilder` in `pty_spawn`.
pub(crate) struct ShellInjection {
    /// The tempdir that holds the generated rc file. Kept alive so the shell
    /// can re-source it if desired (rare, but harmless to support).
    #[allow(dead_code)]
    _tempdir: tempfile::TempDir,
    /// Extra command-line arguments to pass to the shell. For bash, this is
    /// `["--rcfile", "<tempdir>/bash-init"]`. For zsh and other shells: empty.
    extra_args: Vec<OsString>,
    /// Extra environment variables to set on the child process. For zsh, this
    /// is `[("ZDOTDIR", "<tempdir>")]`. For bash and other shells: empty.
    extra_env: Vec<(OsString, OsString)>,
}

impl ShellInjection {
    /// Create a per-session injection for `shell`.
    ///
    /// Creates a fresh `TempDir`, writes the appropriate startup file into it,
    /// and returns the `ShellInjection` with populated `extra_args`/`extra_env`.
    ///
    /// On I/O failure, returns `Err` with a human-readable message so the caller
    /// can soft-fail (log a warning and proceed without injection).
    #[cfg(unix)]
    fn prepare(shell: &str) -> Result<Self, String> {
        use std::os::unix::fs::OpenOptionsExt;

        let tempdir = tempfile::Builder::new()
            .prefix("ai-dungeon-shell-init-")
            .tempdir()
            .map_err(|e| format!("shell-init injection failed: {e}"))?;

        match ShellKind::from_shell_path(shell) {
            ShellKind::Zsh => {
                // Capture the user's current ZDOTDIR (may be unset).
                let original_zdotdir = std::env::var_os("ZDOTDIR");

                let script =
                    build_zsh_init_script(original_zdotdir.as_deref());

                let rc_path = tempdir.path().join(".zshrc");
                std::fs::OpenOptions::new()
                    .mode(0o600)
                    .create_new(true)
                    .write(true)
                    .open(&rc_path)
                    .and_then(|mut f| {
                        use std::io::Write as _;
                        f.write_all(script.as_bytes())
                    })
                    .map_err(|e| format!("shell-init injection failed: {e}"))?;

                let zdotdir_val: OsString = tempdir.path().into();
                Ok(ShellInjection {
                    _tempdir: tempdir,
                    extra_args: vec![],
                    extra_env: vec![(OsString::from("ZDOTDIR"), zdotdir_val)],
                })
            }
            ShellKind::Bash => {
                let script = build_bash_init_script();

                let init_path = tempdir.path().join("bash-init");
                std::fs::OpenOptions::new()
                    .mode(0o600)
                    .create_new(true)
                    .write(true)
                    .open(&init_path)
                    .and_then(|mut f| {
                        use std::io::Write as _;
                        f.write_all(script.as_bytes())
                    })
                    .map_err(|e| format!("shell-init injection failed: {e}"))?;

                let rcfile_path: OsString = init_path.into();
                Ok(ShellInjection {
                    _tempdir: tempdir,
                    extra_args: vec![
                        OsString::from("--rcfile"),
                        rcfile_path,
                    ],
                    extra_env: vec![],
                })
            }
            ShellKind::Other => Ok(ShellInjection {
                _tempdir: tempdir,
                extra_args: vec![],
                extra_env: vec![],
            }),
        }
    }

    /// No-op injection for non-Unix targets (Windows).
    #[cfg(not(unix))]
    fn prepare(_shell: &str) -> Result<Self, String> {
        // tempfile::TempDir still works on Windows; we just don't inject anything.
        let tempdir = tempfile::Builder::new()
            .prefix("ai-dungeon-shell-init-")
            .tempdir()
            .map_err(|e| format!("shell-init injection failed: {e}"))?;
        Ok(ShellInjection {
            _tempdir: tempdir,
            extra_args: vec![],
            extra_env: vec![],
        })
    }
}

/// Build the content of the zsh `.zshrc` written to the per-session tempdir.
///
/// Structure (in order):
/// 1. Restore the user's original `ZDOTDIR` so their real `~/.zshrc` sees the
///    same value it would have without our injection. Uses base64 encoding to
///    avoid all shell metacharacter pitfalls (quotes, `$`, backticks, newlines).
/// 2. Source the user's `~/.zshenv` and `~/.zshrc` if they exist (zsh would
///    normally do this from `$ZDOTDIR`; because we overrode `$ZDOTDIR`, we must
///    do it explicitly).
/// 3. Append the polyglot that defines and wires `__ai_dungeon_emit_ctx`.
#[cfg(unix)]
fn build_zsh_init_script(original_zdotdir: Option<&std::ffi::OsStr>) -> String {
    use std::os::unix::ffi::OsStrExt as _;

    let zdotdir_clause = match original_zdotdir {
        Some(v) => {
            // Encode the raw bytes as standard base64 — handles arbitrary byte
            // sequences including spaces, quotes, $, backticks, and newlines.
            let encoded = B64.encode(v.as_bytes());
            format!(
                "export ZDOTDIR=\"$(printf '%s' '{encoded}' | base64 -d)\"\n",
                encoded = encoded
            )
        }
        None => "unset ZDOTDIR\n".to_string(),
    };

    format!(
        "{zdotdir_clause}\
[ -r \"$HOME/.zshenv\" ] && . \"$HOME/.zshenv\"\n\
[ -r \"$HOME/.zshrc\" ] && . \"$HOME/.zshrc\"\n\
{polyglot}",
        zdotdir_clause = zdotdir_clause,
        polyglot = SHELL_INIT_POLYGLOT,
    )
}

/// Build the content of the bash `bash-init` file written to the per-session tempdir.
///
/// Structure (in order):
/// 1. Source the user's `~/.bashrc` if it exists (bash with `--rcfile` reads
///    only the named file; `.bash_profile`/`.profile` are only for login shells).
/// 2. Append the polyglot that defines and wires `__ai_dungeon_emit_ctx`.
#[cfg(unix)]
fn build_bash_init_script() -> String {
    format!(
        "[ -r \"$HOME/.bashrc\" ] && . \"$HOME/.bashrc\"\n\
{polyglot}",
        polyglot = SHELL_INIT_POLYGLOT,
    )
}

// ── Session ──────────────────────────────────────────────────────────────────

/// Distinguishes a reserved-but-not-yet-spawned session from a fully active one.
///
/// A `Reserved` entry is inserted by `try_reserve_session_id` before any I/O
/// so that duplicate `pty_spawn` calls for the same `session_id` are rejected
/// immediately (before `openpty` is called). Once all I/O succeeds, the entry
/// is replaced with `Active(...)`.
///
/// `pty_write` and `pty_resize` against a `Reserved` entry return a meaningful
/// error rather than panicking.
pub enum PtySessionState {
    /// Slot is claimed; the PTY and shell have not been spawned yet.
    Reserved,
    /// PTY and shell are fully initialised and accepting I/O.
    Active {
        /// The master side of the PTY pair, used for resize.
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
        /// The write half of the PTY master, used for input.
        ///
        /// Held behind its own mutex so blocking writes never hold the outer map
        /// lock while `pty_resize` tries to acquire `master`.
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        /// The spawned child process.
        ///
        /// NOTE: `Box<dyn portable_pty::Child + Send>` — `+ Sync` is NOT required
        /// and WILL fail to compile. Do not add `+ Sync` here.
        child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
        /// Holds the per-session tempdir for the shell-init injection.
        /// Dropping this removes the tempdir; kept alive for the session lifetime
        /// so the shell can re-source files if it chooses to (rare, but harmless).
        #[allow(dead_code)]
        shell_init: ShellInjection,
    },
}

pub struct PtySession {
    /// Session lifecycle state — `Reserved` until I/O completes, then `Active`.
    pub state: PtySessionState,
    /// Set to `true` by `pty_kill` before resources are dropped. The reader
    /// loop checks this flag after each `read()` to decide whether to continue.
    pub shutdown: Arc<AtomicBool>,
    /// Monotonic generation token assigned at reservation time. Increments with
    /// every successful `pty_spawn`. `pty_kill` uses this to scope kills to the
    /// intended session — a stale generation causes the kill to be a no-op.
    pub generation: u64,
}

// ── State ─────────────────────────────────────────────────────────────────────

/// Holds all live (and reserved) PTY sessions plus a per-process generation counter.
///
/// # Design constraints (Ruinor F-7)
/// `next_generation` is a separate `AtomicU64` — the existing map `Mutex` is
/// NOT widened to `Mutex<(HashMap, u64)>`. This keeps the critical section
/// around the map as narrow as possible.
#[derive(Default)]
pub struct PtyState {
    /// Map from session UUID to live session.
    pub map: Mutex<HashMap<String, Arc<PtySession>>>,
    /// Monotonic counter for generation tokens. Starts at `0`; actual sessions
    /// receive `fetch_add(1, Relaxed) + 1` so generations begin at `1`, never `0`.
    /// `0` is reserved as a sentinel meaning "unconditional kill".
    pub next_generation: AtomicU64,
}

// ── Private helpers ───────────────────────────────────────────────────────────

/// Resolve a UTF-8 locale string for the PTY environment.
///
/// Priority order:
/// 1. `LC_ALL` from the host environment — if it already ends with `.UTF-8`,
///    `.utf-8`, `.UTF8`, or `.utf8` (standard `language_TERRITORY.codeset`
///    suffix), pass it through unchanged (respects the user's configuration).
/// 2. `LANG` from the host environment — if it ends with the same suffixes,
///    promote it to `LC_ALL` (uses the host's UI locale).
/// 3. Platform default: `en_US.UTF-8` on macOS (which does not ship `C.UTF-8`
///    in the locale archive) or `C.UTF-8` on all other Unix targets.
///
/// Returns `String` (not `&'static str`) because the first two branches return
/// dynamic values read from the process environment.
fn resolve_pty_utf8_locale() -> String {
    fn is_utf8_locale(v: &str) -> bool {
        v.ends_with(".UTF-8") || v.ends_with(".utf-8") || v.ends_with(".UTF8") || v.ends_with(".utf8")
    }

    if let Ok(v) = std::env::var("LC_ALL") {
        if is_utf8_locale(&v) {
            return v;
        }
    }
    if let Ok(v) = std::env::var("LANG") {
        if is_utf8_locale(&v) {
            return v;
        }
    }
    #[cfg(target_os = "macos")]
    {
        "en_US.UTF-8".to_string()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "C.UTF-8".to_string()
    }
}

/// Reserve a `session_id` slot in the map **before** any I/O.
///
/// Returns `Ok(generation)` when the slot is free; inserts a `Reserved`
/// placeholder and returns the new generation token. Returns
/// `Err("session already exists: …")` when the sid is already present — the
/// map is left unchanged. No I/O is performed under the lock.
///
/// `pty_spawn` calls this as its **first** action so that duplicate-spawn
/// detection is cheap and requires no shell process to have been started.
fn try_reserve_session_id(state: &PtyState, session_id: &str) -> Result<u64, String> {
    let mut map = state.map.lock().map_err(|_| "state mutex poisoned".to_string())?;

    if map.contains_key(session_id) {
        return Err(format!("session already exists: {session_id}"));
    }

    // First-generation invariant (Ruinor F-C): fetch_add returns the pre-increment
    // value. Adding 1 ensures the first session gets generation 1, not 0, so the
    // sentinel value (0 = unconditional kill) is never collided with.
    let generation = state.next_generation.fetch_add(1, Ordering::Relaxed) + 1;

    let placeholder = Arc::new(PtySession {
        state: PtySessionState::Reserved,
        shutdown: Arc::new(AtomicBool::new(false)),
        generation,
    });
    map.insert(session_id.to_string(), placeholder);

    Ok(generation)
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Open a PTY, spawn the user's default shell, and start streaming output
/// to the frontend via `pty:output:{session_id}` events.
///
/// `session_id` is generated by the frontend (UUID) and must be unique per tab.
/// Returns the generation token (`u64`) on success so the frontend can scope
/// subsequent `pty_kill` calls to this exact mount.
///
/// Returns `Err("session already exists: …")` if a session with the same
/// `session_id` is already present in the map — a defensive guard against
/// frontend bugs; the per-sid spawn-chain in Terminal.tsx should make this
/// unreachable in normal operation.
#[tauri::command]
pub async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    // ── Step 1: reserve the slot BEFORE any I/O ───────────────────────────────
    // On duplicate sid: return Err immediately — no shell spawned, nothing to clean up.
    let generation = try_reserve_session_id(&state, &session_id)?;

    // ── Step 2: all I/O; on any failure, free the reservation ─────────────────

    // Resolve the default shell before the closure so the injection can also use it.
    #[cfg(unix)]
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    #[cfg(windows)]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());

    // Prepare the per-session shell-startup injection. On failure, log and
    // proceed with a no-op injection (same baseline as the pre-feature behaviour).
    let shell_init = ShellInjection::prepare(&shell).unwrap_or_else(|e| {
        eprintln!("[ai-dungeon] shell-init injection prepare failed: {e}");
        // Build a fallback no-op injection by creating a fresh TempDir. If even
        // that fails, panic — we cannot continue without a valid ShellInjection.
        ShellInjection {
            _tempdir: tempfile::Builder::new()
                .prefix("ai-dungeon-shell-init-fallback-")
                .tempdir()
                .expect("tempfile::TempDir fallback must succeed"),
            extra_args: vec![],
            extra_env: vec![],
        }
    });

    struct SpawnResult {
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn portable_pty::Child + Send>,
        reader: Box<dyn Read + Send>,
    }

    let result = (|| -> Result<SpawnResult, String> {
        let pty_system = NativePtySystem::default();

        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("openpty failed: {e}"))?;

        let mut cmd = CommandBuilder::new(&shell);

        // App-mandated env entries — must come first.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        #[cfg(unix)]
        cmd.env("LC_ALL", resolve_pty_utf8_locale());

        // Injection env entries — after the app-mandated block.
        for (key, val) in &shell_init.extra_env {
            cmd.env(key, val);
        }

        // Use HOME (Unix) / USERPROFILE (Windows) as the initial working directory.
        #[cfg(unix)]
        if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(home);
        }
        #[cfg(windows)]
        if let Ok(profile) = std::env::var("USERPROFILE") {
            cmd.cwd(profile);
        }

        // Injection args (e.g. --rcfile for bash).
        for arg in &shell_init.extra_args {
            cmd.arg(arg);
        }

        // M-1: Take the writer from the BARE master FIRST, before wrapping master
        // in Arc<Mutex<>>. The writer borrow requires exclusive access to the pair
        // slot; wrapping first would move master before we can call take_writer().
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;

        // Now wrap master in Arc<Mutex<>> for shared resize access.
        let master = Arc::new(Mutex::new(pair.master));

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn failed: {e}"))?;

        // M-3: Clone the reader on the calling thread BEFORE inserting the session
        // into the HashMap. If try_clone_reader fails we return Err cleanly without
        // leaking a half-initialised session entry.
        let reader = master
            .lock()
            .map_err(|_| "master mutex poisoned".to_string())?
            .try_clone_reader()
            .map_err(|e| format!("failed to clone reader: {e}"))?;

        Ok(SpawnResult { master, writer, child, reader })
    })();

    match result {
        Err(e) => {
            // I/O failed — free the reservation so the sid can be retried.
            if let Ok(mut map) = state.map.lock() {
                map.remove(&session_id);
            }
            return Err(e);
        }
        Ok(SpawnResult { master, writer, child, reader }) => {
            let shutdown = Arc::new(AtomicBool::new(false));

            // Replace the Reserved placeholder with the fully-constructed Active session.
            let session = Arc::new(PtySession {
                state: PtySessionState::Active {
                    master: Arc::clone(&master),
                    writer: Arc::new(Mutex::new(writer)),
                    child: Arc::new(Mutex::new(child)),
                    shell_init,
                },
                shutdown: Arc::clone(&shutdown),
                generation,
            });

            state
                .map
                .lock()
                .map_err(|_| "state mutex poisoned".to_string())?
                .insert(session_id.clone(), session);

            // Spawn a blocking thread for the PTY read loop. The reader holds an
            // independent cloned handle — the master mutex remains free for
            // pty_resize to acquire without waiting on a blocked read(). (M-2)
            let app_clone = app.clone();
            let sid = session_id.clone();
            let shutdown_clone = Arc::clone(&shutdown);

            tauri::async_runtime::spawn_blocking(move || {
                let mut buf = [0u8; 4096];
                let mut reader = reader;

                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            // EOF — shell exited.
                            let _ = app_clone.emit(&format!("pty:exit:{sid}"), ());
                            break;
                        }
                        Ok(n) => {
                            if shutdown_clone.load(Ordering::Relaxed) {
                                break;
                            }
                            let encoded = B64.encode(&buf[..n]);
                            let _ = app_clone.emit(&format!("pty:output:{sid}"), encoded);
                        }
                        Err(_) => {
                            if !shutdown_clone.load(Ordering::Relaxed) {
                                let _ = app_clone.emit(&format!("pty:exit:{sid}"), ());
                            }
                            break;
                        }
                    }
                }
            });
        }
    }

    Ok(generation)
}

/// Write base64-encoded bytes to the PTY's input.
///
/// Dispatched off the main thread via `#[tauri::command(async)]`. Plain `fn`
/// commands in Tauri 2 run on the main thread; the `async` annotation moves
/// them to the blocking thread pool.
#[tauri::command(async)]
pub fn pty_write(
    state: State<'_, PtyState>,
    session_id: String,
    data_b64: String,
) -> Result<(), String> {
    // Clone the Arc out of the map; release the outer lock immediately so
    // concurrent resize calls are never serialised behind this write.
    let session = {
        let map = state.map.lock().map_err(|_| "state mutex poisoned")?;
        map.get(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?
            .clone()
    };

    // Guard against writes to a Reserved placeholder — the session slot is
    // claimed but the PTY has not been set up yet.
    let writer = match &session.state {
        PtySessionState::Active { writer, .. } => Arc::clone(writer),
        PtySessionState::Reserved => {
            return Err(format!("session not ready: {session_id}"));
        }
    };

    let bytes = B64
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode failed: {e}"))?;

    let mut w = writer.lock().map_err(|_| "writer mutex poisoned")?;

    w.write_all(&bytes).map_err(|e| format!("write failed: {e}"))?;

    w.flush().map_err(|e| format!("flush failed: {e}"))?;

    Ok(())
}

/// Resize the PTY.
///
/// Dispatched off the main thread via `#[tauri::command(async)]`. Plain `fn`
/// commands in Tauri 2 run on the main thread; the `async` annotation moves
/// them to the blocking thread pool.
#[tauri::command(async)]
pub fn pty_resize(
    state: State<'_, PtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Clone the Arc out of the map; release the outer lock before acquiring master.
    let session = {
        let map = state.map.lock().map_err(|_| "state mutex poisoned")?;
        map.get(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?
            .clone()
    };

    // Guard against resize on a Reserved placeholder — no PTY exists yet.
    let master = match &session.state {
        PtySessionState::Active { master, .. } => Arc::clone(master),
        PtySessionState::Reserved => {
            return Err(format!("session not ready: {session_id}"));
        }
    };

    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    master
        .lock()
        .map_err(|_| "master mutex poisoned")?
        .resize(size)
        .map_err(|e| format!("resize failed: {e}"))?;

    Ok(())
}

/// Kill the PTY session and clean up.
///
/// Returns `Ok(())` if the session is already absent (idempotent).
///
/// `generation` is an optional scoping token. When `Some(g)`, the session is
/// removed only if its stored generation matches `g` — stale kills (from a
/// prior mount's cleanup) are no-ops, protecting the active session. When
/// `None`, the session is removed unconditionally (future-extension safety
/// valve; all current Terminal.tsx call sites pass `Some(generation)`).
#[tauri::command]
pub fn pty_kill(
    state: State<'_, PtyState>,
    session_id: String,
    generation: Option<u64>,
) -> Result<(), String> {
    let session = {
        let mut map = state.map.lock().map_err(|_| "state mutex poisoned")?;
        match map.get(&session_id) {
            None => return Ok(()),
            Some(s) => {
                let should_remove = match generation {
                    None => true,
                    Some(g) => s.generation == g,
                };
                if should_remove {
                    map.remove(&session_id)
                } else {
                    // Stale generation — no-op.
                    return Ok(());
                }
            }
        }
    };

    let session = match session {
        Some(s) => s,
        // Session already gone — idempotent, return Ok.
        None => return Ok(()),
    };

    // Signal the reader loop to stop after its next read returns.
    session.shutdown.store(true, Ordering::Relaxed);

    // Kill the child process and reap it. Only meaningful for Active sessions;
    // Reserved placeholders have no child process.
    // Dropping the session (including PtySessionState::Active::shell_init) also
    // removes the per-session tempdir from the filesystem.
    if let PtySessionState::Active { child, .. } = &session.state {
        if let Ok(mut c) = child.lock() {
            let _ = c.kill();
            // On Unix, a process that exits without being waited becomes a zombie
            // until the parent calls waitpid.
            // `kill()` terminates the child; `wait()` reaps it. `wait()` returns
            // immediately if the child already exited.
            // Reap the child to avoid zombie processes on Unix (POSIX waitpid semantics).
            let _ = c.wait();
        }
    }

    Ok(())
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    // ── Helpers ───────────────────────────────────────────────────────────────

    /// Build a minimal `PtyState` for tests that only exercise the map/generation
    /// layer (no real PTY or shell process is spawned).
    fn make_state() -> PtyState {
        PtyState::default()
    }

    /// Insert a `Reserved` `PtySession` with the given `generation` directly into
    /// the map, bypassing `pty_spawn`. This lets the generation-aware kill tests
    /// operate without spawning a real shell — a `Reserved` session has no child
    /// process or writer to clean up.
    fn insert_fake_session(state: &PtyState, session_id: &str, generation: u64) {
        let session = Arc::new(PtySession {
            state: PtySessionState::Reserved,
            shutdown: Arc::new(AtomicBool::new(false)),
            generation,
        });

        state
            .map
            .lock()
            .expect("state mutex poisoned in test")
            .insert(session_id.to_string(), session);
    }

    /// Call the generation-aware kill logic directly (mirrors what the updated
    /// `pty_kill` command does in production).
    fn kill_with_generation(state: &PtyState, session_id: &str, generation: Option<u64>) {
        let mut map = state.map.lock().expect("state mutex poisoned in test");
        if let Some(session) = map.get(session_id) {
            let should_remove = match generation {
                None => true,
                Some(g) => session.generation == g,
            };
            if should_remove {
                let removed = map.remove(session_id).unwrap();
                removed.shutdown.store(true, Ordering::Relaxed);
            }
        }
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    /// `try_reserve_session_id` must return `Ok(1)` on the first call, then
    /// `Err("session already exists: …")` on the second call with the same sid,
    /// leaving the original generation-1 reservation intact.
    #[test]
    #[serial]
    fn pty_spawn_rejects_duplicate_session_id() {
        let state = make_state();

        let gen1 =
            try_reserve_session_id(&state, "sid-A").expect("first reservation must succeed");
        assert_eq!(gen1, 1, "first allocated generation must be 1");

        let err = try_reserve_session_id(&state, "sid-A")
            .expect_err("duplicate reservation must return Err");
        assert!(
            err.contains("session already exists"),
            "error message must contain 'session already exists', got: {err}"
        );

        // Original entry must still be present with generation 1.
        let map = state.map.lock().unwrap();
        let entry = map.get("sid-A").expect("original entry must remain in map");
        assert_eq!(entry.generation, 1, "original entry's generation must be unchanged");
    }

    /// A `pty_kill` with a stale generation must be a no-op — the session at the
    /// newer generation must survive.
    #[test]
    #[serial]
    fn pty_kill_with_stale_generation_is_noop() {
        let state = make_state();

        // Simulate two successive spawns at the same sid (generation 1 then 2).
        insert_fake_session(&state, "sid-B", 1);
        // Overwrite with generation 2 (as if a remount replaced the session).
        insert_fake_session(&state, "sid-B", 2);

        // A kill carrying the old generation (1) must not remove generation 2.
        kill_with_generation(&state, "sid-B", Some(1));

        let map = state.map.lock().unwrap();
        let entry =
            map.get("sid-B").expect("session at generation 2 must survive a stale kill");
        assert_eq!(entry.generation, 2, "generation 2 session must be untouched");
    }

    /// A `pty_kill` with the matching generation must remove the session.
    #[test]
    #[serial]
    fn pty_kill_with_matching_generation_removes_session() {
        let state = make_state();
        insert_fake_session(&state, "sid-C", 5);

        kill_with_generation(&state, "sid-C", Some(5));

        let map = state.map.lock().unwrap();
        assert!(map.get("sid-C").is_none(), "session must be removed on matching generation");
    }

    /// A `pty_kill` with `None` generation must remove the session unconditionally.
    #[test]
    #[serial]
    fn pty_kill_with_none_generation_removes_session() {
        let state = make_state();
        insert_fake_session(&state, "sid-D", 7);

        kill_with_generation(&state, "sid-D", None);

        let map = state.map.lock().unwrap();
        assert!(map.get("sid-D").is_none(), "session must be removed on None generation");
    }

    /// Tauri argument deserialisation contract: a JSON payload without a
    /// `generation` field must deserialise to `generation: None` (not an error).
    ///
    /// This validates plain serde behaviour (necessary but not sufficient — the
    /// authoritative gate is the Step 4 manual DevTools smoke test per Ruinor F-B).
    #[test]
    #[serial]
    fn pty_kill_command_accepts_missing_generation_field() {
        #[derive(serde::Deserialize, Debug, PartialEq)]
        struct PtyKillArgs {
            session_id: String,
            generation: Option<u64>,
        }

        let payload = r#"{"session_id": "X"}"#;
        let result: Result<PtyKillArgs, _> = serde_json::from_str(payload);
        assert!(
            result.is_ok(),
            "deserialisation must succeed for missing generation field; got: {:?}",
            result.err()
        );
        let args = result.unwrap();
        assert_eq!(args.session_id, "X");
        assert_eq!(args.generation, None);
    }

    // ── Locale resolution tests ───────────────────────────────────────────────
    //
    // These tests mutate process-global env vars via `std::env::set_var` /
    // `std::env::remove_var`. They are annotated `#[serial]` (along with all
    // other tests in this module) to prevent parallel execution from producing
    // env-var races. Annotating only the new tests would be insufficient because
    // a new test could still race with an existing test scheduled concurrently.
    //
    // Each test uses `EnvGuard` to save and restore the original env-var value
    // on drop, so a panicking assertion cannot leave the process env dirty for
    // subsequent tests (R-DEF-2).

    /// RAII guard that saves an env var's current value on construction and
    /// restores it on drop. Ensures test-local mutations are always reversed,
    /// even when the test panics.
    struct EnvGuard {
        key: String,
        original: Option<String>,
    }

    impl EnvGuard {
        /// Save the current value of `key` and set it to `value`.
        fn set(key: &str, value: &str) -> Self {
            let original = std::env::var(key).ok();
            // Safety: single-threaded per `#[serial]` on every test in this module.
            unsafe { std::env::set_var(key, value) };
            EnvGuard { key: key.to_string(), original }
        }

        /// Save the current value of `key` and remove it.
        fn remove(key: &str) -> Self {
            let original = std::env::var(key).ok();
            // Safety: single-threaded per `#[serial]` on every test in this module.
            unsafe { std::env::remove_var(key) };
            EnvGuard { key: key.to_string(), original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            // Safety: single-threaded per `#[serial]` on every test in this module.
            match &self.original {
                Some(v) => unsafe { std::env::set_var(&self.key, v) },
                None => unsafe { std::env::remove_var(&self.key) },
            }
        }
    }

    /// When `LC_ALL` is already set to a UTF-8 locale, `resolve_pty_utf8_locale`
    /// must return it unchanged (priority 1).
    #[test]
    #[serial]
    fn resolve_pty_utf8_locale_returns_lc_all_when_utf8() {
        let _lc_all = EnvGuard::set("LC_ALL", "en_GB.UTF-8");
        let result = resolve_pty_utf8_locale();
        assert_eq!(result, "en_GB.UTF-8");
    }

    /// A value that merely contains "UTF-8" as a substring (not as a
    /// `.codeset` suffix) must NOT be treated as a UTF-8 locale — the resolver
    /// must fall through to the platform default.
    #[test]
    #[serial]
    fn resolve_pty_utf8_locale_rejects_substring_utf8_in_lc_all() {
        let _lc_all = EnvGuard::set("LC_ALL", "utf-8-experiment");
        let _lang = EnvGuard::remove("LANG");
        let result = resolve_pty_utf8_locale();
        // Must be the platform default, not the bogus LC_ALL value.
        #[cfg(target_os = "macos")]
        assert_eq!(result, "en_US.UTF-8");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(result, "C.UTF-8");
    }

    /// A value that merely contains "UTF-8" as a substring in LANG must also
    /// be rejected; the resolver falls through to the platform default.
    #[test]
    #[serial]
    fn resolve_pty_utf8_locale_rejects_substring_utf8_in_lang() {
        let _lc_all = EnvGuard::remove("LC_ALL");
        let _lang = EnvGuard::set("LANG", "my-UTF-8-experiment");
        let result = resolve_pty_utf8_locale();
        #[cfg(target_os = "macos")]
        assert_eq!(result, "en_US.UTF-8");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(result, "C.UTF-8");
    }

    /// `.UTF8` (without hyphen) is also a valid codeset suffix and must be accepted.
    #[test]
    #[serial]
    fn resolve_pty_utf8_locale_accepts_utf8_without_hyphen() {
        let _lc_all = EnvGuard::set("LC_ALL", "en_US.UTF8");
        let _lang = EnvGuard::remove("LANG");
        let result = resolve_pty_utf8_locale();
        assert_eq!(result, "en_US.UTF8");
    }

    /// When `LC_ALL` is absent or non-UTF-8 but `LANG` is a UTF-8 locale,
    /// `resolve_pty_utf8_locale` must promote `LANG` (priority 2).
    #[test]
    #[serial]
    fn resolve_pty_utf8_locale_promotes_lang_when_lc_all_missing() {
        let _lc_all = EnvGuard::remove("LC_ALL");
        let _lang = EnvGuard::set("LANG", "de_DE.UTF-8");
        let result = resolve_pty_utf8_locale();
        assert_eq!(result, "de_DE.UTF-8");
    }

    /// When neither `LC_ALL` nor `LANG` is set to a UTF-8 locale,
    /// `resolve_pty_utf8_locale` must return the platform default (priority 3).
    #[test]
    #[serial]
    fn resolve_pty_utf8_locale_falls_back_to_platform_default() {
        let _lc_all = EnvGuard::remove("LC_ALL");
        let _lang = EnvGuard::remove("LANG");
        let result = resolve_pty_utf8_locale();
        #[cfg(target_os = "macos")]
        assert_eq!(result, "en_US.UTF-8");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(result, "C.UTF-8");
    }

    // ── Shell injection tests ─────────────────────────────────────────────────

    /// `ShellKind::from_shell_path` must classify zsh and bash paths correctly,
    /// and return `Other` for all unrecognised shells.
    #[test]
    #[serial]
    fn shell_kind_classifies_zsh_bash_and_other() {
        // zsh variants
        assert_eq!(ShellKind::from_shell_path("/bin/zsh"), ShellKind::Zsh);
        assert_eq!(ShellKind::from_shell_path("/usr/local/bin/zsh"), ShellKind::Zsh);
        assert_eq!(ShellKind::from_shell_path("zsh"), ShellKind::Zsh);

        // bash variants
        assert_eq!(ShellKind::from_shell_path("/bin/bash"), ShellKind::Bash);
        assert_eq!(ShellKind::from_shell_path("bash"), ShellKind::Bash);

        // Other shells
        assert_eq!(ShellKind::from_shell_path("/bin/fish"), ShellKind::Other);
        assert_eq!(ShellKind::from_shell_path("/bin/sh"), ShellKind::Other);
        assert_eq!(ShellKind::from_shell_path("/usr/bin/dash"), ShellKind::Other);
        assert_eq!(ShellKind::from_shell_path(""), ShellKind::Other);
    }

    /// `ShellInjection::prepare("/bin/zsh")` must write a `.zshrc` in the tempdir
    /// that contains `__ai_dungeon_emit_ctx`, `ZDOTDIR`, `$HOME/.zshenv`, and
    /// `$HOME/.zshrc`.
    #[cfg(unix)]
    #[test]
    #[serial]
    fn shell_injection_prepare_zsh_writes_zshrc() {
        let inj = ShellInjection::prepare("/bin/zsh").expect("prepare must succeed");
        let rc_path = inj._tempdir.path().join(".zshrc");
        assert!(rc_path.exists(), ".zshrc must exist in the tempdir");
        let contents = std::fs::read_to_string(&rc_path).expect("must be readable");
        assert!(
            contents.contains("__ai_dungeon_emit_ctx"),
            ".zshrc must contain __ai_dungeon_emit_ctx; got:\n{contents}"
        );
        assert!(
            contents.contains("ZDOTDIR"),
            ".zshrc must contain ZDOTDIR restore clause; got:\n{contents}"
        );
        assert!(
            contents.contains("$HOME/.zshenv"),
            ".zshrc must source $HOME/.zshenv; got:\n{contents}"
        );
        assert!(
            contents.contains("$HOME/.zshrc"),
            ".zshrc must source $HOME/.zshrc; got:\n{contents}"
        );
    }

    /// `ShellInjection::prepare("/bin/bash")` must write a `bash-init` in the
    /// tempdir that contains `__ai_dungeon_emit_ctx` and the `.bashrc` source
    /// guard.
    #[cfg(unix)]
    #[test]
    #[serial]
    fn shell_injection_prepare_bash_writes_init_file() {
        let inj = ShellInjection::prepare("/bin/bash").expect("prepare must succeed");
        let init_path = inj._tempdir.path().join("bash-init");
        assert!(init_path.exists(), "bash-init must exist in the tempdir");
        let contents = std::fs::read_to_string(&init_path).expect("must be readable");
        assert!(
            contents.contains("__ai_dungeon_emit_ctx"),
            "bash-init must contain __ai_dungeon_emit_ctx; got:\n{contents}"
        );
        assert!(
            contents.contains("[ -r \"$HOME/.bashrc\" ]"),
            "bash-init must contain .bashrc source guard; got:\n{contents}"
        );
    }

    /// `ShellInjection::prepare` for an unrecognised shell must return empty
    /// args and env lists (no-op injection).
    #[cfg(unix)]
    #[test]
    #[serial]
    fn shell_injection_prepare_other_is_noop() {
        let inj = ShellInjection::prepare("/usr/bin/fish").expect("prepare must succeed");
        assert!(
            inj.extra_args.is_empty(),
            "Other shell must have no extra args; got: {:?}",
            inj.extra_args
        );
        assert!(
            inj.extra_env.is_empty(),
            "Other shell must have no extra env; got: {:?}",
            inj.extra_env
        );
    }

    /// For zsh, the args list must be empty and the env list must contain exactly
    /// one entry with key `ZDOTDIR` pointing at the tempdir.
    #[cfg(unix)]
    #[test]
    #[serial]
    fn shell_injection_zsh_args_and_env() {
        let inj = ShellInjection::prepare("/bin/zsh").expect("prepare must succeed");
        assert!(
            inj.extra_args.is_empty(),
            "zsh injection must have no extra args; got: {:?}",
            inj.extra_args
        );
        assert_eq!(
            inj.extra_env.len(),
            1,
            "zsh injection must have exactly one env entry; got: {:?}",
            inj.extra_env
        );
        assert_eq!(
            inj.extra_env[0].0,
            OsString::from("ZDOTDIR"),
            "env key must be ZDOTDIR"
        );
        assert_eq!(
            inj.extra_env[0].1,
            OsString::from(inj._tempdir.path()),
            "env value must be the tempdir path"
        );
    }

    /// For bash, the env list must be empty and the args list must be exactly
    /// `["--rcfile", "<tempdir>/bash-init"]`.
    #[cfg(unix)]
    #[test]
    #[serial]
    fn shell_injection_bash_args_and_env() {
        let inj = ShellInjection::prepare("/bin/bash").expect("prepare must succeed");
        assert!(
            inj.extra_env.is_empty(),
            "bash injection must have no extra env; got: {:?}",
            inj.extra_env
        );
        assert_eq!(
            inj.extra_args.len(),
            2,
            "bash injection must have exactly two args; got: {:?}",
            inj.extra_args
        );
        assert_eq!(inj.extra_args[0], OsString::from("--rcfile"));
        let expected_path = inj._tempdir.path().join("bash-init");
        assert_eq!(
            inj.extra_args[1],
            OsString::from(expected_path),
            "second arg must be the bash-init path"
        );
    }

    /// When `ZDOTDIR` is set in the host env, the generated `.zshrc` must
    /// contain the original value (base64-encoded for round-trip safety).
    #[cfg(unix)]
    #[test]
    #[serial]
    fn shell_injection_zsh_script_restores_original_zdotdir() {
        let original = "/custom/zsh/dotfiles";
        let _guard = EnvGuard::set("ZDOTDIR", original);

        let inj = ShellInjection::prepare("/bin/zsh").expect("prepare must succeed");
        let rc_path = inj._tempdir.path().join(".zshrc");
        let contents = std::fs::read_to_string(rc_path).expect("must be readable");

        // The script must contain the base64 encoding of the original value.
        let encoded = B64.encode(original.as_bytes());
        assert!(
            contents.contains(&encoded),
            ".zshrc must contain base64-encoded original ZDOTDIR '{encoded}'; got:\n{contents}"
        );
        // Must also contain the base64 -d decode pattern.
        assert!(
            contents.contains("base64 -d"),
            ".zshrc must use base64 -d to decode ZDOTDIR; got:\n{contents}"
        );
    }

    /// When `ZDOTDIR` is unset in the host env, the generated `.zshrc` must
    /// contain an `unset ZDOTDIR` clause.
    #[cfg(unix)]
    #[test]
    #[serial]
    fn shell_injection_zsh_script_unsets_zdotdir_when_original_absent() {
        let _guard = EnvGuard::remove("ZDOTDIR");

        let inj = ShellInjection::prepare("/bin/zsh").expect("prepare must succeed");
        let rc_path = inj._tempdir.path().join(".zshrc");
        let contents = std::fs::read_to_string(rc_path).expect("must be readable");

        assert!(
            contents.contains("unset ZDOTDIR"),
            ".zshrc must contain 'unset ZDOTDIR' when original was absent; got:\n{contents}"
        );
    }
}
