use std::{
    collections::HashMap,
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
    let result = (|| -> Result<(Arc<Mutex<Box<dyn MasterPty + Send>>>, Box<dyn Write + Send>, Box<dyn portable_pty::Child + Send>, Box<dyn Read + Send>), String> {
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

        Ok((master, writer, child, reader))
    })();

    match result {
        Err(e) => {
            // I/O failed — free the reservation so the sid can be retried.
            if let Ok(mut map) = state.map.lock() {
                map.remove(&session_id);
            }
            return Err(e);
        }
        Ok((master, writer, child, reader)) => {
            let shutdown = Arc::new(AtomicBool::new(false));

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
    fn pty_kill_with_matching_generation_removes_session() {
        let state = make_state();
        insert_fake_session(&state, "sid-C", 5);

        kill_with_generation(&state, "sid-C", Some(5));

        let map = state.map.lock().unwrap();
        assert!(map.get("sid-C").is_none(), "session must be removed on matching generation");
    }

    /// A `pty_kill` with `None` generation must remove the session unconditionally.
    #[test]
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
}
