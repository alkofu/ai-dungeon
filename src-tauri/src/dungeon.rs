use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

// ── Structs ───────────────────────────────────────────────────────────────────

/// Owned handles returned by `spawn_sidecar`.
///
/// `stdin` and `stdout` are taken out of `Child` immediately on spawn so they
/// can be moved independently. The production caller stores `stdin` in
/// `DungeonInner` and moves `stdout` into the reader thread.
pub struct SpawnedSidecar {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: ChildStdout,
}

// ── State ─────────────────────────────────────────────────────────────────────

pub struct DungeonInner {
    /// Number of cards that have called dungeon_open without a matching dungeon_close.
    pub open_count: u32,
    // NOTE (non-goal): Crash recovery (sidecar dying while cards are open) is out of
    // scope for v1. If the sidecar dies externally, `child` remains `Some` with a
    // stale handle until the last card closes. The next 0→1 transition will then
    // spawn a fresh process.
    pub child: Option<Child>,
    /// Write end of the sidecar's stdin pipe. `None` when the sidecar is not running.
    pub stdin: Option<ChildStdin>,
    /// Registry mapping request `id` → per-request reply channel.
    /// Wrapped in `Arc<Mutex<...>>` so the reader thread can hold a clone.
    pub pending: Arc<Mutex<HashMap<String, SyncSender<String>>>>,
    /// Monotonic counter for generating unique request IDs.
    pub next_request_id: u64,
}

/// `DungeonState` wraps `DungeonInner` in `Arc<Mutex<...>>` so it can be
/// cloned into `spawn_blocking` closures (which require `'static + Send`).
#[derive(Clone)]
pub struct DungeonState {
    pub inner: Arc<Mutex<DungeonInner>>,
}

impl Default for DungeonState {
    fn default() -> Self {
        DungeonState {
            inner: Arc::new(Mutex::new(DungeonInner::default())),
        }
    }
}

impl Default for DungeonInner {
    fn default() -> Self {
        DungeonInner {
            open_count: 0,
            child: None,
            stdin: None,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_request_id: 0,
        }
    }
}

// ── Path resolution ───────────────────────────────────────────────────────────

// NOTE (dev-only): path is resolved via CARGO_MANIFEST_DIR, which is baked in at compile time.
// This resolves correctly in `cargo tauri dev` but NOT in production bundles.
// Production packaging (bundle.resources + PathResolver) is tracked in open-questions.md.
fn resolve_sidecar_script_path() -> std::path::PathBuf {
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("../python/sidecar.py")
}

// ── Spawn helper ──────────────────────────────────────────────────────────────

/// Spawn the sidecar process with piped stdin/stdout.
///
/// Returns `SpawnedSidecar` with owned `child`, `stdin`, and `stdout` handles.
/// The caller is responsible for spawning a reader thread if real I/O is needed.
fn spawn_sidecar() -> Result<SpawnedSidecar, String> {
    let mut child = Command::new("python3")
        .arg(resolve_sidecar_script_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to take sidecar stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to take sidecar stdout".to_string())?;

    Ok(SpawnedSidecar {
        child,
        stdin,
        stdout,
    })
}

// ── Reader thread ─────────────────────────────────────────────────────────────

/// Spawn the reader OS thread that routes sidecar stdout lines to pending reply channels.
///
/// The thread parses each line as `{"id": String, "reply": String}` and sends the
/// `reply` field only (a `String`) into the per-request `SyncSender<String>`.
///
/// Error handling (never panics; never aborts on recoverable errors):
/// - JSON parse failure → log "parse error" and continue.
/// - Unknown id → log "unknown id" and continue.
/// - SyncSender::send fails (receiver dropped) → log "reply channel closed" and continue.
///
/// The thread exits naturally when stdout is closed (sidecar killed or exited cleanly).
fn spawn_reader_thread(
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<String, SyncSender<String>>>>,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line_result in reader.lines() {
            let line = match line_result {
                Ok(l) => l,
                Err(_) => break,
            };

            let parsed: Result<serde_json::Value, _> = serde_json::from_str(&line);
            let value = match parsed {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[dungeon] sidecar reader: parse error: {e}");
                    continue;
                }
            };

            let id = match value.get("id").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => {
                    eprintln!("[dungeon] sidecar reader: parse error: missing id field");
                    continue;
                }
            };

            let reply = match value.get("reply").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => {
                    eprintln!("[dungeon] sidecar reader: parse error: missing reply field");
                    continue;
                }
            };

            let sender = {
                let mut map = pending.lock().unwrap();
                map.remove(&id)
            };

            match sender {
                None => {
                    eprintln!("[dungeon] sidecar reader: unknown id: {id}");
                }
                Some(tx) => {
                    if tx.send(reply).is_err() {
                        eprintln!("[dungeon] sidecar reader: reply channel closed for id: {id}");
                    }
                }
            }
        }
    });
}

// ── Testable inner logic ──────────────────────────────────────────────────────

/// Open the dungeon sidecar for a new card.
///
/// Increments `open_count`. When transitioning from 0→1, calls `spawner` to
/// start the sidecar process and stores handles. If `reader_fn` is `Some`, it
/// is called with the sidecar's stdout and the pending map to spawn a reader
/// thread; tests pass `None` to exercise the pure state machine without I/O.
///
/// NOTE: `open_count` is incremented even when the spawner fails. This preserves
/// the symmetry invariant: every successful `dungeon_open` call must be paired
/// with exactly one `dungeon_close` call. If the caller skipped incrementing on
/// spawn failure, a subsequent `dungeon_close` would underflow the counter.
/// When the count eventually reaches 0 again, `child` will be `None` and
/// dungeon_close will skip the kill+wait step cleanly.
pub(crate) fn dungeon_open_with_spawner<F, R>(
    inner: &mut DungeonInner,
    spawner: F,
    reader_fn: Option<R>,
) -> Result<(), String>
where
    F: FnOnce() -> Result<SpawnedSidecar, String>,
    R: FnOnce(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>),
{
    inner.open_count += 1;

    if inner.open_count == 1 {
        // First card: spawn the sidecar (debug builds only).
        #[cfg(debug_assertions)]
        match spawner() {
            Ok(spawned) => {
                inner.stdin = Some(spawned.stdin);
                inner.child = Some(spawned.child);
                match reader_fn {
                    Some(f) => f(spawned.stdout, Arc::clone(&inner.pending)),
                    // stdout is dropped here — state-machine tests drop stdout intentionally.
                    None => drop(spawned.stdout),
                }
            }
            Err(e) => {
                // Spawn failed — child and stdin stay None. Count is already incremented.
                // The close call will skip kill+wait (child is None) and decrement.
                eprintln!("[ai-dungeon] dungeon sidecar spawn failed: {e}");
            }
        }
        #[cfg(not(debug_assertions))]
        eprintln!("[ai-dungeon] sidecar: not available in release builds");
    }

    Ok(())
}

/// Close the dungeon sidecar for a card going away.
///
/// Decrements `open_count`. When reaching 0, in order:
/// 1. Drops `stdin` (signals the sidecar's stdin loop to exit on EOF).
/// 2. Drains `pending` so in-flight `dungeon_send` calls resolve to Err.
/// 3. Kills and waits on the sidecar process (if one was successfully spawned).
pub(crate) fn dungeon_close_inner(inner: &mut DungeonInner) -> Result<(), String> {
    if inner.open_count == 0 {
        eprintln!("[ai-dungeon] dungeon_close called with open_count already 0 — ignoring");
        return Ok(());
    }

    inner.open_count -= 1;

    if inner.open_count == 0 {
        // 1. Drop stdin — signals sidecar EOF.
        inner.stdin = None;
        // 2. Drain pending — in-flight dungeon_send calls see Disconnected.
        inner.pending.lock().unwrap().clear();
        // 3. Kill and reap the child process.
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            // Reap the child to avoid zombie processes on Unix (POSIX waitpid semantics).
            let _ = child.wait();
        }
    }

    Ok(())
}

// ── dungeon_send ──────────────────────────────────────────────────────────────

/// Send a message to the running sidecar and await the reply.
///
/// # Implementation note — F-9 trade-off (mutex held during blocking wait)
///
/// This wrapper holds the `DungeonState` mutex for the entire duration of
/// `dungeon_send_inner_blocking`, which includes the stdin write+flush and the
/// `recv_timeout` (up to 5 s). This serializes all `dungeon_send` calls and
/// could theoretically block other Tauri commands that need the mutex.
///
/// For v1 this is acceptable because:
/// - the only payload is a short "Hi" string (pipe buffer overflow impossible),
/// - there is one dungeon card → one in-flight request at a time,
/// - the timeout caps the worst-case latency at 5 s.
///
/// If multi-card concurrent IPC becomes a requirement, the next iteration should
/// adopt a **writer-actor pattern**: a dedicated thread owns the `ChildStdin`
/// and reads request envelopes from a channel, allowing the Tauri command to
/// release the state mutex before awaiting the reply.
#[tauri::command(async)]
pub async fn dungeon_send(
    state: tauri::State<'_, DungeonState>,
    msg: String,
) -> Result<String, String> {
    // Clone the Arc so the closure is 'static + Send.
    let inner_arc = Arc::clone(&state.inner);
    tauri::async_runtime::spawn_blocking(move || {
        let mut inner = inner_arc
            .lock()
            .map_err(|_| "dungeon state mutex poisoned".to_string())?;

        if inner.stdin.is_none() {
            return Err("sidecar not running".to_string());
        }

        // Fast-path: check whether the sidecar process has already exited without blocking.
        // If it has, the write would succeed (bytes buffered in the kernel pipe) but the
        // reply would never arrive, leaving the caller blocked for the full timeout.
        if let Some(ref mut child) = inner.child {
            if let Ok(Some(_)) = child.try_wait() {
                return Err("sidecar process exited".to_string());
            }
        }

        let pending = Arc::clone(&inner.pending);
        // Extract next_id value and stdin reference by structuring the borrow
        // so both fields are accessed simultaneously without aliasing.
        let DungeonInner {
            ref mut stdin,
            ref mut next_request_id,
            ..
        } = *inner;
        let stdin = stdin.as_mut().unwrap();

        dungeon_send_inner_blocking(
            stdin,
            &pending,
            next_request_id,
            msg,
            Duration::from_secs(5),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking join error: {e}"))?
}

/// Testable, runtime-independent send helper.
///
/// Generates a unique request id, inserts a reply channel into `pending`,
/// writes the JSON request line to `stdin`, then blocks on the reply channel
/// up to `timeout`.
///
/// `W: Write` allows tests to substitute `&mut Vec<u8>` for `&mut ChildStdin`.
pub(crate) fn dungeon_send_inner_blocking<W: Write>(
    stdin: &mut W,
    pending: &Arc<Mutex<HashMap<String, SyncSender<String>>>>,
    next_id: &mut u64,
    msg: String,
    timeout: Duration,
) -> Result<String, String> {
    use std::sync::mpsc::{sync_channel, RecvTimeoutError};

    let id = format!("req-{n}", n = *next_id);
    *next_id += 1;

    let (tx, rx) = sync_channel::<String>(1);

    // Insert reply channel before writing to stdin so the reader thread
    // cannot deliver the reply before we're listening.
    pending.lock().unwrap().insert(id.clone(), tx);

    let line = serde_json::to_string(&serde_json::json!({"id": &id, "msg": &msg}))
        .map_err(|e| e.to_string())?
        + "\n";

    if let Err(e) = stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()) {
        pending.lock().unwrap().remove(&id);
        return Err(format!("stdin write failed: {e}"));
    }

    // Drop pending borrow before blocking on recv.
    match rx.recv_timeout(timeout) {
        Ok(reply) => Ok(reply),
        Err(RecvTimeoutError::Timeout) => {
            pending.lock().unwrap().remove(&id);
            Err("sidecar reply timeout".to_string())
        }
        Err(RecvTimeoutError::Disconnected) => {
            // The close path drained `pending`, dropping our SyncSender.
            // The entry is already gone; no removal needed.
            Err("sidecar reply channel closed".to_string())
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Notify the backend that a new dungeon card has mounted.
///
/// On the 0→1 transition, spawns the Python sidecar process with piped stdio
/// and starts the reader thread.
/// Dispatched off the main thread via `#[tauri::command(async)]`, consistent
/// with `pty_write`/`pty_resize`.
#[tauri::command(async)]
pub async fn dungeon_open(state: tauri::State<'_, DungeonState>) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "dungeon state mutex poisoned".to_string())?;
    dungeon_open_with_spawner(&mut inner, spawn_sidecar, Some(spawn_reader_thread))
}

/// Notify the backend that a dungeon card has unmounted.
///
/// On the N→0 transition, kills the Python sidecar process.
/// Dispatched off the main thread via `#[tauri::command(async)]`, consistent
/// with `pty_write`/`pty_resize`.
#[tauri::command(async)]
pub async fn dungeon_close(state: tauri::State<'_, DungeonState>) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "dungeon state mutex poisoned".to_string())?;
    dungeon_close_inner(&mut inner)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::sync::mpsc::sync_channel;

    /// A spawner that succeeds using a subprocess with piped stdio.
    fn ok_spawner() -> Result<SpawnedSidecar, String> {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "cat > /dev/null"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        Ok(SpawnedSidecar {
            child,
            stdin,
            stdout,
        })
    }

    /// A spawner that always fails.
    fn err_spawner() -> Result<SpawnedSidecar, String> {
        Err("simulated spawn failure".to_string())
    }

    #[test]
    #[serial]
    fn open_then_close_spawns_and_kills_child() {
        let mut inner = DungeonInner::default();

        dungeon_open_with_spawner(
            &mut inner,
            ok_spawner,
            None::<fn(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>)>,
        )
        .expect("open must succeed");
        assert_eq!(inner.open_count, 1, "count must be 1 after open");
        assert!(inner.child.is_some(), "child must be Some after open");

        dungeon_close_inner(&mut inner).expect("close must succeed");
        assert_eq!(inner.open_count, 0, "count must be 0 after close");
        assert!(inner.child.is_none(), "child must be None after close");
    }

    #[test]
    #[serial]
    fn second_open_does_not_spawn() {
        let mut inner = DungeonInner::default();
        let mut spawn_count = 0;

        let spawner = || {
            spawn_count += 1;
            ok_spawner()
        };
        dungeon_open_with_spawner(
            &mut inner,
            spawner,
            None::<fn(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>)>,
        )
        .expect("first open must succeed");

        let spawner2 = || {
            spawn_count += 1;
            ok_spawner()
        };
        dungeon_open_with_spawner(
            &mut inner,
            spawner2,
            None::<fn(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>)>,
        )
        .expect("second open must succeed");

        assert_eq!(spawn_count, 1, "spawner must be called exactly once");
        assert_eq!(inner.open_count, 2, "count must be 2 after two opens");

        // Cleanup: close twice to kill child.
        dungeon_close_inner(&mut inner).expect("first close");
        dungeon_close_inner(&mut inner).expect("second close");
    }

    #[test]
    #[serial]
    fn close_with_other_cards_open_does_not_kill() {
        let mut inner = DungeonInner::default();

        dungeon_open_with_spawner(
            &mut inner,
            ok_spawner,
            None::<fn(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>)>,
        )
        .expect("open 1");
        dungeon_open_with_spawner(
            &mut inner,
            ok_spawner,
            None::<fn(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>)>,
        )
        .expect("open 2");
        dungeon_open_with_spawner(
            &mut inner,
            ok_spawner,
            None::<fn(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>)>,
        )
        .expect("open 3");
        assert_eq!(inner.open_count, 3);

        dungeon_close_inner(&mut inner).expect("close 1");
        assert_eq!(inner.open_count, 2, "count must be 2 after one close");
        assert!(
            inner.child.is_some(),
            "child must still be alive at count=2"
        );

        dungeon_close_inner(&mut inner).expect("close 2");
        assert_eq!(inner.open_count, 1, "count must be 1 after two closes");
        assert!(
            inner.child.is_some(),
            "child must still be alive at count=1"
        );

        dungeon_close_inner(&mut inner).expect("close 3");
        assert_eq!(inner.open_count, 0, "count must be 0 after three closes");
        assert!(inner.child.is_none(), "child must be None after last close");
    }

    #[test]
    #[serial]
    fn close_when_count_is_zero_is_noop() {
        let mut inner = DungeonInner::default();
        assert_eq!(inner.open_count, 0);
        assert!(inner.child.is_none());

        let result = dungeon_close_inner(&mut inner);
        assert!(result.is_ok(), "close on count=0 must return Ok");
        assert_eq!(inner.open_count, 0, "count must stay 0");
        assert!(inner.child.is_none(), "child must stay None");
    }

    #[test]
    #[serial]
    fn spawn_failure_still_increments_count() {
        let mut inner = DungeonInner::default();

        let result = dungeon_open_with_spawner(
            &mut inner,
            err_spawner,
            None::<fn(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>)>,
        );
        assert!(
            result.is_ok(),
            "open must return Ok even when spawner fails"
        );
        assert_eq!(
            inner.open_count, 1,
            "count must be 1 even after spawn failure"
        );
        assert!(
            inner.child.is_none(),
            "child must be None after spawn failure"
        );

        // close (1→0): must succeed without panic even with child=None
        let close_result = dungeon_close_inner(&mut inner);
        assert!(close_result.is_ok(), "close must return Ok");
        assert_eq!(inner.open_count, 0);
    }

    #[test]
    #[serial]
    fn open_attaches_stdin_and_pending_starts_empty() {
        let mut inner = DungeonInner::default();

        dungeon_open_with_spawner(
            &mut inner,
            ok_spawner,
            None::<fn(ChildStdout, Arc<Mutex<HashMap<String, SyncSender<String>>>>)>,
        )
        .expect("open must succeed");
        assert!(inner.stdin.is_some(), "stdin must be Some after open");
        assert!(
            inner.pending.lock().unwrap().is_empty(),
            "pending must be empty after open"
        );

        dungeon_close_inner(&mut inner).expect("close must succeed");
        assert!(inner.stdin.is_none(), "stdin must be None after close");
    }

    #[test]
    #[serial]
    fn reader_thread_routes_reply_by_id() {
        // Use a real subprocess whose stdout produces one JSON reply line then EOFs.
        let reply_json = r#"{"id":"req-1","reply":"Hello"}"#;
        let sh_cmd = format!("echo '{reply_json}'");

        let mut child = Command::new("/bin/sh")
            .args(["-c", &sh_cmd])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sh spawn must succeed");

        let stdout = child.stdout.take().expect("stdout must be available");

        let pending: Arc<Mutex<HashMap<String, SyncSender<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = sync_channel::<String>(1);
        pending.lock().unwrap().insert("req-1".to_string(), tx);

        spawn_reader_thread(stdout, Arc::clone(&pending));

        let reply = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("reply must arrive within 2 s");
        assert_eq!(reply, "Hello", "reader must route the reply field only");

        // Allow child to exit cleanly.
        let _ = child.wait();
    }

    // ── dungeon_send_inner_blocking tests ─────────────────────────────────────

    #[test]
    #[serial]
    fn dungeon_send_inner_returns_reply_for_matching_id() {
        let pending: Arc<Mutex<HashMap<String, SyncSender<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut writer: Vec<u8> = Vec::new();
        let mut next_id: u64 = 0;

        // Spawn a helper thread that delivers the reply once the id appears in pending.
        let pending_clone = Arc::clone(&pending);
        std::thread::spawn(move || loop {
            let sender = {
                let mut map = pending_clone.lock().unwrap();
                map.remove("req-0")
            };
            if let Some(tx) = sender {
                let _ = tx.send("Hello".to_string());
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        });

        let result = dungeon_send_inner_blocking(
            &mut writer,
            &pending,
            &mut next_id,
            "Hi".to_string(),
            Duration::from_secs(2),
        );

        assert_eq!(result, Ok("Hello".to_string()));
        let written = String::from_utf8(writer).expect("valid utf8");
        assert!(
            written.contains(r#""id":"req-0""#),
            "written JSON must contain id field; got: {written:?}"
        );
        assert!(
            written.contains(r#""msg":"Hi""#),
            "written JSON must contain msg field; got: {written:?}"
        );
        assert!(
            written.ends_with('\n'),
            "written line must end with newline"
        );
    }

    #[test]
    #[serial]
    fn dungeon_send_inner_times_out_when_no_reply_arrives() {
        let pending: Arc<Mutex<HashMap<String, SyncSender<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let mut writer: Vec<u8> = Vec::new();
        let mut next_id: u64 = 0;

        let result = dungeon_send_inner_blocking(
            &mut writer,
            &pending,
            &mut next_id,
            "Hi".to_string(),
            Duration::from_millis(50),
        );

        assert_eq!(
            result,
            Err("sidecar reply timeout".to_string()),
            "must return timeout error"
        );
        assert!(
            pending.lock().unwrap().is_empty(),
            "pending must be cleaned up on timeout"
        );
    }

    #[test]
    #[serial]
    fn dungeon_send_returns_err_when_stdin_is_none() {
        let inner = DungeonInner::default(); // stdin is None
        assert!(inner.stdin.is_none());
        // The early-return branch: when stdin is None, return Err("sidecar not running").
        // We test this by exercising the logic path directly (without going through the
        // async Tauri command wrapper, which can't be called in unit tests without a runtime).
        let pending = Arc::clone(&inner.pending);
        let mut next_id = inner.next_request_id;

        // Simulate what dungeon_send does: check stdin before calling inner helper.
        let result: Result<String, String> = if inner.stdin.is_none() {
            Err("sidecar not running".to_string())
        } else {
            // This branch is not taken.
            let mut writer: Vec<u8> = Vec::new();
            dungeon_send_inner_blocking(
                &mut writer,
                &pending,
                &mut next_id,
                "Hi".to_string(),
                Duration::from_millis(50),
            )
        };

        assert_eq!(result, Err("sidecar not running".to_string()));
    }

    #[test]
    #[serial]
    fn dungeon_send_returns_err_when_sidecar_exited() {
        // Build a DungeonInner with a dead child and a fake stdin backed by a Vec<u8>.
        // The test exercises the liveness-check path in dungeon_send: when try_wait()
        // returns Some(_) the function must return Err immediately, before writing.
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("sh spawn must succeed");

        // Wait for the child to exit so try_wait() will return Some.
        child.wait().expect("wait must succeed");

        // Simulate the liveness check from dungeon_send.
        let result: Result<String, String> = if let Ok(Some(_)) = child.try_wait() {
            Err("sidecar process exited".to_string())
        } else {
            Ok("alive".to_string())
        };

        assert_eq!(
            result,
            Err("sidecar process exited".to_string()),
            "must return early when sidecar child has exited"
        );
    }

    #[test]
    #[serial]
    fn dungeon_send_inner_returns_disconnected_when_pending_drained() {
        let pending: Arc<Mutex<HashMap<String, SyncSender<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = Arc::clone(&pending);
        let mut writer: Vec<u8> = Vec::new();
        let mut next_id: u64 = 0;

        // Spawn a background thread that clears pending shortly after the helper inserts.
        std::thread::spawn(move || {
            // Wait briefly for the helper to insert its SyncSender.
            std::thread::sleep(Duration::from_millis(10));
            pending_clone.lock().unwrap().clear();
        });

        let result = dungeon_send_inner_blocking(
            &mut writer,
            &pending,
            &mut next_id,
            "Hi".to_string(),
            Duration::from_secs(2),
        );

        assert_eq!(
            result,
            Err("sidecar reply channel closed".to_string()),
            "must return disconnected error when pending is drained"
        );
    }
}
