use std::process::{Child, Command};
use std::sync::Mutex;

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct DungeonInner {
    /// Number of cards that have called dungeon_open without a matching dungeon_close.
    pub open_count: u32,
    // NOTE (non-goal): Crash recovery (sidecar dying while cards are open) is out of
    // scope for v1. If the sidecar dies externally, `child` remains `Some` with a
    // stale handle until the last card closes. The next 0→1 transition will then
    // spawn a fresh process.
    pub child: Option<Child>,
}

#[derive(Default)]
pub struct DungeonState {
    inner: Mutex<DungeonInner>,
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

fn spawn_sidecar() -> Result<Child, String> {
    Command::new("python3")
        .arg(resolve_sidecar_script_path())
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {e}"))
}

// ── Testable inner logic ──────────────────────────────────────────────────────

/// Open the dungeon sidecar for a new card.
///
/// Increments `open_count`. When transitioning from 0→1, calls `spawner` to
/// start the sidecar process.
///
/// NOTE: `open_count` is incremented even when the spawner fails. This preserves
/// the symmetry invariant: every successful `dungeon_open` call must be paired
/// with exactly one `dungeon_close` call. If the caller skipped incrementing on
/// spawn failure, a subsequent `dungeon_close` would underflow the counter.
/// When the count eventually reaches 0 again, `child` will be `None` and
/// dungeon_close will skip the kill+wait step cleanly.
pub(crate) fn dungeon_open_with_spawner<F>(
    inner: &mut DungeonInner,
    _spawner: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<Child, String>,
{
    inner.open_count += 1;

    if inner.open_count == 1 {
        // First card: spawn the sidecar (debug builds only).
        #[cfg(debug_assertions)]
        match _spawner() {
            Ok(child) => {
                inner.child = Some(child);
            }
            Err(e) => {
                // Spawn failed — child stays None. Count is already incremented.
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
/// Decrements `open_count`. When reaching 0, kills and waits on the sidecar
/// process (if one was successfully spawned). Clamps at zero.
pub(crate) fn dungeon_close_inner(inner: &mut DungeonInner) -> Result<(), String> {
    if inner.open_count == 0 {
        eprintln!("[ai-dungeon] dungeon_close called with open_count already 0 — ignoring");
        return Ok(());
    }

    inner.open_count -= 1;

    if inner.open_count == 0 {
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
            // Reap the child to avoid zombie processes on Unix (POSIX waitpid semantics).
            let _ = child.wait();
        }
    }

    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Notify the backend that a new dungeon card has mounted.
///
/// On the 0→1 transition, spawns the Python sidecar process.
/// Dispatched off the main thread via `#[tauri::command(async)]`, consistent
/// with `pty_write`/`pty_resize`.
#[tauri::command(async)]
pub async fn dungeon_open(state: tauri::State<'_, DungeonState>) -> Result<(), String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "dungeon state mutex poisoned".to_string())?;
    dungeon_open_with_spawner(&mut inner, spawn_sidecar)
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

    /// A spawner that always succeeds by running `sleep 1`.
    fn ok_spawner() -> Result<Child, String> {
        Command::new("/bin/sh")
            .args(["-c", "sleep 1"])
            .spawn()
            .map_err(|e| e.to_string())
    }

    /// A spawner that always fails.
    fn err_spawner() -> Result<Child, String> {
        Err("simulated spawn failure".to_string())
    }

    #[test]
    #[serial]
    fn open_then_close_spawns_and_kills_child() {
        let mut inner = DungeonInner::default();

        dungeon_open_with_spawner(&mut inner, ok_spawner).expect("open must succeed");
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
        dungeon_open_with_spawner(&mut inner, spawner).expect("first open must succeed");

        let spawner2 = || {
            spawn_count += 1;
            ok_spawner()
        };
        dungeon_open_with_spawner(&mut inner, spawner2).expect("second open must succeed");

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

        dungeon_open_with_spawner(&mut inner, ok_spawner).expect("open 1");
        dungeon_open_with_spawner(&mut inner, ok_spawner).expect("open 2");
        dungeon_open_with_spawner(&mut inner, ok_spawner).expect("open 3");
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

        let result = dungeon_open_with_spawner(&mut inner, err_spawner);
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
}
