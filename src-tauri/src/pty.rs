use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
#[cfg(unix)]
use nix::sys::termios::{tcgetattr, tcdrain, tcsetattr, LocalFlags, SetArg};
#[cfg(unix)]
use std::os::fd::BorrowedFd;
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem as _};
use tauri::{AppHandle, Emitter, State};

// ── Shell init polyglot ───────────────────────────────────────────────────────
//
// This string is written verbatim to the PTY master immediately after spawn so
// that the shell's line discipline queues it as stdin before the user's rc
// files finish executing.
//
// Known limitation (rc-file race): the bytes are written before the shell has
// read its rc file, relying on the TTY line discipline to buffer the input until
// the shell is ready. This usually works, but a user's ~/.zshrc that does
// `precmd_functions=()` (bare assignment, not `+=`) would clobber our hook.
// The mitigation is `add-zsh-hook` on zsh (deduplication-safe, append-style)
// and `PROMPT_COMMAND` prepend on bash (safe against user appends, but not
// against outright replacement with bare assignment).
//
// ECHO-window mitigation:
// After `openpty`, the PTY's line discipline has ECHO enabled by default. The
// spawned shell only clears ECHO once it has read its rc files and put the line
// discipline into raw/cbreak mode for interactive editing. If we write the
// polyglot in that window, the kernel echoes every byte back out the master, and
// the frontend's xterm.js renders the polyglot text as visible garbage above the
// first prompt. `with_echo_disabled` brackets the write with a tcgetattr /
// ECHO-clear / tcsetattr(TCSANOW) / write / tcdrain / tcsetattr(restore)
// sequence on the master FD so the slave never sees ECHO-on for our bytes. On
// Linux and macOS, the master and slave PTY ends share a single line-discipline
// termios object, so `tcgetattr`/`tcsetattr` against the master FD modifies the
// same ECHO bit the slave sees — verified by portable-pty's own
// `MasterPty::get_termios` implementation, which uses the same pattern. This
// mitigation is best-effort: if any termios syscall fails, we log a warning and
// proceed (the user sees the legacy echo behaviour, which is the pre-fix
// baseline and therefore safe).
//
// The script:
//   1. Defines __ai_dungeon_emit_ctx() which emits OSC 7 (CWD) and OSC 7337
//      (git context) after every prompt.
//   2. Wires the function into the prompt cycle for bash and zsh.
//   3. Is a single newline-terminated line suitable for piping to a shell stdin.
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

/// Run `body` with the PTY master's termios `ECHO` flag temporarily cleared.
///
/// Saves the current termios via `tcgetattr`, clears `ECHO`, applies via
/// `tcsetattr(TCSANOW)`, runs `body`, calls `tcdrain` so the slave has
/// consumed any bytes `body` wrote, then restores the original termios.
///
/// On Linux and macOS, the master and slave PTY ends share a single
/// line-discipline termios object, so `tcgetattr`/`tcsetattr` against the
/// master FD modifies the same ECHO bit the slave sees — verified by
/// portable-pty's own `MasterPty::get_termios` implementation, which uses
/// the same pattern.
///
/// Note: `tcdrain` on a PTY master returns once the slave-side line
/// discipline has accepted the bytes (not waiting for user-space shell to
/// consume them), so it cannot deadlock against a not-yet-exec'd shell.
///
/// Failure-branch matrix — every termios syscall soft-fails:
/// - (a) `tcgetattr` fails → log, run body anyway, skip drain, skip restore.
///   The caller sees the legacy echo behaviour (pre-fix baseline), safe.
/// - (b) `tcgetattr` ok, clear-`tcsetattr` fails → log, run body, skip drain,
///   skip restore (state was never modified).
/// - (c) `tcgetattr` ok, clear ok, body completes, `tcdrain` fails → log,
///   still attempt restore.
/// - (d) `tcgetattr` ok, clear ok, drain ok, restore-`tcsetattr` fails → log only.
/// - (e) All-success → normal path.
///
/// This mitigation is best-effort: a termios failure logs a warning and
/// proceeds without short-circuiting `body` or leaving the master in an
/// unknown state.
#[cfg(unix)]
fn with_echo_disabled<F: FnOnce()>(master_fd: std::os::unix::io::RawFd, body: F) {
    // SAFETY: We borrow (not own) the FD that portable-pty holds. BorrowedFd
    // never closes the underlying file descriptor on drop.
    let fd = unsafe { BorrowedFd::borrow_raw(master_fd) };

    // Branch (a): tcgetattr fails — run body, skip drain and restore.
    let original = match tcgetattr(fd) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[ai-dungeon] termios tcgetattr failed: {e}");
            body();
            return;
        }
    };

    let mut modified = original.clone();
    modified.local_flags.remove(LocalFlags::ECHO);

    let fd = unsafe { BorrowedFd::borrow_raw(master_fd) };

    // Branch (b): clear-tcsetattr fails — run body, skip drain and restore.
    if let Err(e) = tcsetattr(fd, SetArg::TCSANOW, &modified) {
        eprintln!("[ai-dungeon] termios tcsetattr (clear ECHO) failed: {e}");
        body();
        return;
    }

    body();

    // Branch (c): tcdrain fails — log but still attempt restore.
    let fd = unsafe { BorrowedFd::borrow_raw(master_fd) };
    if let Err(e) = tcdrain(fd) {
        eprintln!("[ai-dungeon] termios tcdrain failed: {e}");
    }

    // Branch (d): restore-tcsetattr fails — log only.
    let fd = unsafe { BorrowedFd::borrow_raw(master_fd) };
    if let Err(e) = tcsetattr(fd, SetArg::TCSANOW, &original) {
        eprintln!("[ai-dungeon] termios tcsetattr (restore ECHO) failed: {e}");
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
    #[allow(clippy::type_complexity)]
    let result = (|| -> Result<(Arc<Mutex<Box<dyn MasterPty + Send>>>, Box<dyn Write + Send>, Box<dyn portable_pty::Child + Send>, Box<dyn Read + Send>, i32), String> {
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

        // Resolve the default shell.
        #[cfg(unix)]
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        #[cfg(windows)]
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());

        let mut cmd = CommandBuilder::new(&shell);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        #[cfg(unix)]
        cmd.env("LC_ALL", resolve_pty_utf8_locale());

        // Use HOME (Unix) / USERPROFILE (Windows) as the initial working directory.
        #[cfg(unix)]
        if let Ok(home) = std::env::var("HOME") {
            cmd.cwd(home);
        }
        #[cfg(windows)]
        if let Ok(profile) = std::env::var("USERPROFILE") {
            cmd.cwd(profile);
        }

        // M-1: Take the writer from the BARE master FIRST, before wrapping master
        // in Arc<Mutex<>>. The writer borrow requires exclusive access to the pair
        // slot; wrapping first would move master before we can call take_writer().
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take_writer failed: {e}"))?;

        // Capture the raw FD before pair.master is moved into Arc<Mutex<>>.
        // On Unix, MasterPty::as_raw_fd() always returns Some; -1 is a safe
        // sentinel that will cause with_echo_disabled to soft-fail gracefully.
        #[cfg(unix)]
        let master_fd: i32 = pair.master.as_raw_fd().unwrap_or(-1);
        #[cfg(not(unix))]
        let master_fd: i32 = -1;

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

        Ok((master, writer, child, reader, master_fd))
    })();

    match result {
        Err(e) => {
            // I/O failed — free the reservation so the sid can be retried.
            if let Ok(mut map) = state.map.lock() {
                map.remove(&session_id);
            }
            return Err(e);
        }
        Ok((master, mut writer, child, reader, master_fd)) => {
            let shutdown = Arc::new(AtomicBool::new(false));

            // Inject the shell init polyglot on Unix so bash/zsh emit OSC 7 (CWD) and
            // OSC 7337 (git context) after every prompt cycle. We write to the bare
            // `writer` binding here — before it is wrapped in `Arc<Mutex<>>` and inserted
            // into the map — so the write is uncontended and cannot race with `pty_write`,
            // `pty_kill`, or a remount-spawn on the same sid (the session is still
            // unreachable from any other code path at this point).
            //
            // `with_echo_disabled` brackets the write with a save/clear/`tcdrain`/restore
            // sequence on the master FD to prevent the kernel from echoing the polyglot
            // bytes back to the frontend before the shell has put the line discipline into
            // its interactive (non-echoing) mode. See the ECHO-window mitigation comment
            // above `SHELL_INIT_POLYGLOT` for details.
            //
            // Failure modes handled by `with_echo_disabled` (soft-fail on all):
            //   1. tcgetattr fails  — body runs with echo still enabled (legacy behaviour).
            //   2. tcsetattr fails  — body runs with echo still enabled (state unmodified).
            //   3. write/flush fail — logged; the session continues without OSC context.
            #[cfg(unix)]
            with_echo_disabled(master_fd, || {
                if let Err(e) = writer.write_all(SHELL_INIT_POLYGLOT.as_bytes()) {
                    eprintln!("[ai-dungeon] shell init injection write failed: {e}");
                } else if let Err(e) = writer.flush() {
                    eprintln!("[ai-dungeon] shell init injection flush failed: {e}");
                }
            });

            // Replace the Reserved placeholder with the fully-constructed Active session.
            let session = Arc::new(PtySession {
                state: PtySessionState::Active {
                    master: Arc::clone(&master),
                    writer: Arc::new(Mutex::new(writer)),
                    child: Arc::new(Mutex::new(child)),
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

    // ── with_echo_disabled tests ──────────────────────────────────────────────

    /// `with_echo_disabled` must clear ECHO inside the body and restore it after.
    ///
    /// Opens a real PTY pair via `nix::pty::openpty`, asserts ECHO is initially
    /// set on the master, calls `with_echo_disabled` with a body that reads back
    /// termios to assert ECHO is cleared, then asserts ECHO is restored after the
    /// call returns.
    #[cfg(unix)]
    #[test]
    #[serial]
    fn with_echo_disabled_clears_and_restores_echo() {
        use nix::pty::openpty;
        use nix::sys::termios::{tcgetattr, LocalFlags};
        use std::os::fd::{AsFd, AsRawFd};

        let pty = openpty(None, None).expect("openpty must succeed in test");
        let master_fd_raw = pty.master.as_fd().as_raw_fd();

        // ECHO must be set initially (post-openpty default).
        let initial = tcgetattr(pty.master.as_fd()).expect("tcgetattr must succeed on fresh PTY");
        assert!(
            initial.local_flags.contains(LocalFlags::ECHO),
            "ECHO must be set on a freshly opened PTY master"
        );

        let mut echo_inside = true; // assume cleared; body will correct this
        with_echo_disabled(master_fd_raw, || {
            let t = tcgetattr(pty.master.as_fd()).expect("tcgetattr inside body must succeed");
            echo_inside = t.local_flags.contains(LocalFlags::ECHO);
        });

        assert!(!echo_inside, "ECHO must be cleared inside the body");

        // ECHO must be restored after with_echo_disabled returns.
        let after = tcgetattr(pty.master.as_fd()).expect("tcgetattr after body must succeed");
        assert!(
            after.local_flags.contains(LocalFlags::ECHO),
            "ECHO must be restored after with_echo_disabled returns"
        );
    }

    /// `with_echo_disabled` must still run the body when `tcgetattr` fails (soft-fail
    /// branch (a)). Using an FD that is guaranteed to be closed forces `EBADF`.
    #[cfg(unix)]
    #[test]
    #[serial]
    fn with_echo_disabled_runs_body_when_tcgetattr_fails() {
        use std::cell::Cell;
        use std::os::unix::io::IntoRawFd;

        // Open a file, extract its raw FD, then explicitly close it.
        // The resulting FD value is now invalid (EBADF), exercising branch (a).
        let file = std::fs::File::open("/dev/null").expect("open /dev/null must succeed");
        let invalid_fd = file.into_raw_fd();
        // Explicitly close the fd so it becomes invalid (EBADF).
        // nix::unistd::close is available unconditionally (unistd mod is not feature-gated).
        let _ = nix::unistd::close(invalid_fd);

        let body_ran = Cell::new(false);
        with_echo_disabled(invalid_fd, || {
            body_ran.set(true);
        });
        assert!(body_ran.get(), "body must run even when tcgetattr fails (soft-fail)");
    }

    /// `with_echo_disabled` must still run the body when the FD is a regular file
    /// (i.e., not a TTY). `tcgetattr` returns `ENOTTY`, exercising soft-fail branch (a).
    #[cfg(unix)]
    #[test]
    #[serial]
    fn with_echo_disabled_runs_body_for_non_tty_fd() {
        use std::cell::Cell;
        use std::os::unix::io::AsRawFd;

        let file = std::fs::File::open("/dev/null").expect("open /dev/null must succeed");
        let fd = file.as_raw_fd();

        let body_ran = Cell::new(false);
        // /dev/null is not a TTY; tcgetattr returns ENOTTY, exercising branch (a).
        with_echo_disabled(fd, || {
            body_ran.set(true);
        });
        assert!(body_ran.get(), "body must run even for a non-TTY fd (ENOTTY soft-fail)");
    }
}
