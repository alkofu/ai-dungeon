import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface SessionContext {
  cwd: string | null;
  git: { repo: string; branch: string } | null;
}

interface TerminalProps {
  // The caller supplies a stable UUID that identifies this PTY session. The
  // same sessionId across re-renders means the same shell; a different sessionId
  // triggers a full unmount/re-spawn via the useEffect dependency array.
  sessionId: string;
  // Called whenever an OSC 7 or OSC 7337 sequence arrives with updated context.
  // Optional so existing callers that omit it continue to type-check.
  onContextChange?: (ctx: SessionContext) => void;
}

// ── Per-sid spawn-chain (Ruinor F-1 resolution) ───────────────────────────────
//
// Module-level per-sid serialisation queue. Every pty_spawn for a given
// sessionId is awaited after the previous mount's full spawn-then-kill chain
// has settled. This prevents StrictMode mount → unmount → remount from
// colliding two pty_spawn calls at the backend, and prevents Mount A's
// deferred kill from racing Mount B's fresh spawn.
//
// Memory bound (Ruinor F-11): each entry is a (string, settled-Promise) pair,
// ~100 bytes per entry. 10,000 distinct sessionIds across an app session
// therefore costs ~1 MB. We do NOT delete entries when a kill settles because
// a sessionId can be re-mounted later (e.g., Tabs unmount/remount, future
// session-restore features) and an early delete would race a re-mount that
// arrives during the kill window. The trade-off is acceptable: 1 MB at
// 10,000 entries is negligible vs. the correctness cost of a wrong-time
// delete. If a future feature creates >10,000 unique sessionIds in one
// app session, revisit with an LRU eviction strategy.
//
// Type-safety note (Ruinor F-12): the Map value is typed Promise<unknown>
// because mount-cleanup chains mix Promise<number> (spawn) and Promise<void>
// (kill). When a caller needs the generation token, USE THE LOCAL
// `spawnPromise` REFERENCE (typed Promise<number>), NOT spawnChain.get(sid)
// (typed Promise<unknown> | undefined). Reading the generation off the Map
// would silently lose type information and require an unsafe cast.
const spawnChain = new Map<string, Promise<unknown>>();

// ── Test utility ──────────────────────────────────────────────────────────────
// Exported so Vitest beforeEach hooks can clear the chain between tests.
// Do NOT call this in production code.
export function _clearSpawnChainForTesting(): void {
  spawnChain.clear();
}

export function Terminal({ sessionId, onContextChange }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Stable ref so OSC handlers always call the latest callback without needing
  // it in the useEffect dependency array (which would re-mount the terminal on
  // every render where the parent re-creates the callback reference).
  const onContextChangeRef = useRef(onContextChange);
  onContextChangeRef.current = onContextChange;

  useEffect(() => {
    if (!containerRef.current) return;

    // Track whether the async spawn has completed so the ResizeObserver
    // callback and onData handler know whether the PTY is ready.
    const isReadyRef = { current: false };

    // Track whether cleanup has run so the async IIFE can bail early.
    let cancelled = false;

    // Collect IPC unlisten functions to call during cleanup.
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    // Collect the onData disposable for cleanup.
    let onDataDisposable: { dispose: () => void } | undefined;

    // Buffer for keystrokes that arrive before the PTY is ready. Each entry is
    // a discrete xterm onData string and is encoded + sent independently to
    // preserve per-keystroke handling semantics.
    const pendingWrites: string[] = [];

    // ── Terminal & FitAddon ───────────────────────────────────────────────────
    const term = new XTerm();
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // ── OSC 7 / OSC 7337 context handlers ────────────────────────────────────
    // Closure-scoped state threads both fields through each handler.
    // Per-effect-instance: resets on sessionId change (correct — new shell session)
    // but overwrites parent state if the Terminal remounts without a sessionId change.
    let lastCwd: string | null = null;
    let lastGit: { repo: string; branch: string } | null = null;

    // OSC 7: file://hostname/path — update CWD.
    // Uses new URL().pathname to correctly handle both file://hostname/path and
    // file:///path (empty host). decodeURIComponent handles percent-encoded
    // characters (e.g. spaces in directory names); the inner try/catch falls back
    // to the raw pathname if the encoding is malformed.
    const osc7Handler = term.parser.registerOscHandler(7, (data): boolean | Promise<boolean> => {
      try {
        try {
          lastCwd = decodeURIComponent(new URL(data).pathname);
        } catch {
          lastCwd = new URL(data).pathname; // fallback: use raw pathname if decode fails
        }
      } catch {
        // Malformed URL — leave lastCwd unchanged.
      }
      onContextChangeRef.current?.({ cwd: lastCwd, git: lastGit });
      return true;
    });

    // OSC 7337: custom git context — empty payload clears, "repo\tbranch" sets.
    const osc7337Handler = term.parser.registerOscHandler(
      7337,
      (data): boolean | Promise<boolean> => {
        if (data === "") {
          lastGit = null;
        } else {
          const [repo, branch] = data.split("\t");
          lastGit = { repo, branch };
        }
        onContextChangeRef.current?.({ cwd: lastCwd, git: lastGit });
        return true;
      },
    );

    // ── encodeBase64 helper ───────────────────────────────────────────────────
    // Encodes a xterm data string to UTF-8 bytes, then base64. Returns the
    // base64 string.
    //
    // btoa() is called once on the fully concatenated `bin` string (not per
    // chunk). Chunking exists solely to avoid stack overflow in
    // String.fromCharCode.apply, which has a call-stack limit on large arrays.
    const encoder = new TextEncoder();
    function encodeBase64(data: string): string {
      const bytes = encoder.encode(data);
      // Chunked base64 encoding to handle large paste payloads safely.
      // String.fromCharCode.apply has a stack limit; process in 8 KiB chunks.
      const CHUNK = 8192;
      let bin = "";
      for (let offset = 0; offset < bytes.length; offset += CHUNK) {
        const chunk = bytes.subarray(offset, offset + CHUNK);
        bin += String.fromCharCode.apply(null, chunk as unknown as number[]);
      }
      return btoa(bin);
    }

    // ── Register onData synchronously ─────────────────────────────────────────
    // Registered here (before fitAddon.fit() and before the async IIFE) so that
    // keystrokes typed during the spawn window are captured rather than dropped.
    // While isReadyRef.current is false, keystrokes are buffered into
    // pendingWrites. Once the PTY is ready, keystrokes are forwarded live.
    onDataDisposable = term.onData((data) => {
      if (!isReadyRef.current) {
        pendingWrites.push(data);
        return;
      }
      const dataB64 = encodeBase64(data);
      invoke("pty_write", { sessionId, dataB64 }).catch((err) => {
        // Guard with `cancelled` for defence-in-depth: onDataDisposable.dispose()
        // prevents new callbacks from firing after unmount, but in-flight invoke()
        // promises that were already initiated before dispose() can still settle.
        if (!cancelled) {
          term.writeln(`\r\n[pty write failed: ${String(err)}]`);
        }
      });
    });

    // FitAddon.fit() returns silently when dimensions are zero (not a throw).
    fitAddon.fit();

    // ── ResizeObserver ────────────────────────────────────────────────────────
    // Always call fitAddon.fit() — the PTY resize IPC only fires once ready.
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      if (!isReadyRef.current) return;

      const dims = fitAddon.proposeDimensions();
      if (!dims) return;

      // Fire-and-forget: resize errors are non-fatal.
      void invoke("pty_resize", {
        sessionId,
        cols: dims.cols,
        rows: dims.rows,
      });
    });
    observer.observe(containerRef.current);

    // ── Spawn-chain: append this mount's spawn to the per-sid chain ───────────
    // `previousChain` is whatever the prior mount (or a prior kill) settled as.
    // The `.catch(() => undefined)` ensures a prior failure does not poison this
    // mount — every mount gets a clean start regardless of what came before.
    //
    // `spawnPromise` is typed Promise<number> (the generation token returned by
    // the backend). Always reference this local variable when you need the
    // generation — do NOT read it back from spawnChain.get(sessionId), which is
    // typed Promise<unknown> and would require an unsafe cast (Ruinor F-12).
    const dims = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };
    const previousChain = spawnChain.get(sessionId) ?? Promise.resolve();
    const spawnPromise: Promise<number> = previousChain
      .catch(() => undefined)
      .then(() => invoke<number>("pty_spawn", { sessionId, cols: dims.cols, rows: dims.rows }));

    // Store a kill-tolerant version of spawnPromise in the chain so the next
    // mount can extend it safely. The local `spawnPromise` reference (typed
    // Promise<number>) is retained below for the IIFE and cleanup to use.
    spawnChain.set(
      sessionId,
      spawnPromise.catch(() => undefined),
    );

    // ── Async IIFE: subscribe to events after spawn resolves ──────────────────
    void (async () => {
      let generation: number | undefined;

      try {
        // Await the spawn-chain promise (which invokes pty_spawn on the backend).
        // This ensures Mount B's pty_spawn always starts after Mount A's pty_kill
        // has been issued (the spawn-chain serialises them per-sid).
        generation = await spawnPromise;
      } catch (err) {
        if (!cancelled) {
          term.writeln(`\r\n[failed to start shell: ${String(err)}]`);
        }
        return;
      }

      // If the component unmounted while pty_spawn was in flight, cleanup's
      // deferred kill (via the spawn chain) handles termination — no need to
      // invoke pty_kill here.
      // Cleanup's deferred kill (via the spawn chain) handles termination if
      // cancelled — no need to invoke pty_kill here.
      if (cancelled) return;

      // ── Listen for PTY output ───────────────────────────────────────────────
      // The payload is a base64-encoded string. We decode it to a Uint8Array
      // before passing to term.write() for binary fidelity.
      //
      // NOTE: We use atob() + Uint8Array rather than TextDecoder because the
      // PTY stream may contain non-UTF-8 bytes (e.g. readline escape sequences,
      // mouse reporting, raw binary). Treating the decoded bytes as UTF-16 via
      // TextDecoder would corrupt them for xterm, which expects raw bytes.
      unlistenOutput = await listen<string>(`pty:output:${sessionId}`, (event) => {
        const b64 = event.payload;
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        term.write(bytes);
      });

      // The exit listener captures `generation` to scope its pty_kill to this
      // mount's session — it cannot accidentally kill a successor session at the
      // same sessionId (Ruinor F-4).
      unlistenExit = await listen(`pty:exit:${sessionId}`, () => {
        term.writeln("\r\n[process exited]");
        // Remove the dead session from the backend HashMap. pty_kill is
        // idempotent (returns Ok when the session is absent), so this is safe
        // even if cleanup has already run.
        void invoke("pty_kill", { sessionId, generation });
      });

      if (cancelled) return;

      // ── Flush buffered pre-ready keystrokes ────────────────────────────────
      // Drain pendingWrites in FIFO order before setting isReadyRef.current.
      // The loop body is fully synchronous, so no keystroke event can interleave
      // between iterations. Setting isReadyRef.current after the flush ensures
      // live writes begin only after all buffered ones are sent.
      while (pendingWrites.length > 0) {
        // Check cancelled at the top of each iteration to avoid issuing
        // redundant pty_write IPC calls to a session being concurrently killed.
        // (F-2: this ordering is load-bearing for the .catch guard below.)
        if (cancelled) break;
        const data = pendingWrites.shift()!;
        const dataB64 = encodeBase64(data);
        invoke("pty_write", { sessionId, dataB64 }).catch((err) => {
          // Guard with `cancelled` because term may be disposed by the time
          // this .catch fires (cleanup sets cancelled = true before term.dispose()).
          if (!cancelled) {
            term.writeln(`\r\n[pty write failed: ${String(err)}]`);
          }
        });
      }

      isReadyRef.current = true;
    })();

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      // Set cancelled = true BEFORE term.dispose() so that any in-flight
      // pty_write .catch callbacks (flush-loop path) see cancelled = true and
      // skip the term.writeln call on the already-disposed terminal.
      // This ordering is load-bearing for the cancelled guard in the flush loop.
      cancelled = true;
      // Clear the pending queue so a remount does not replay stale input from
      // this unmounted instance.
      pendingWrites.length = 0;
      observer.disconnect();
      onDataDisposable?.dispose();
      osc7Handler.dispose();
      osc7337Handler.dispose();
      unlistenOutput?.();
      unlistenExit?.();
      // Defer pty_kill until the in-flight spawnPromise has settled.
      // Use the local spawnPromise (typed Promise<number>) so the generation is
      // typed as number in the .then callback. Reading from spawnChain here
      // would erase the type to unknown (Ruinor F-12).
      // The cleanup remains synchronous from React's perspective — the .then(...)
      // chain is fire-and-forget and React does not await it.
      const killPromise = spawnPromise
        .then((generation) => invoke("pty_kill", { sessionId, generation }))
        .catch(() => undefined); // spawn failed → nothing to kill
      spawnChain.set(sessionId, killPromise);
      term.dispose();
    };
  }, [sessionId]);

  // React 19 StrictMode mounts → unmounts → remounts this effect in dev.
  // The cleanup (dispose + disconnect) handles this correctly.
  // In DevTools, verify that exactly one element with data-testid="terminal-root"
  // exists after initial render.
  //
  // Note on minHeight: 0 here vs. AppShell.Main:
  // - AppShell.Main has minHeight: 0 so it can flex-shrink within the AppShell
  //   flex column and not overflow the viewport.
  // - This inner div has minHeight: 0 so it can flex-shrink within AppShell.Main
  //   (which itself is a flex column). Both are required for height: 100% on this
  //   div to resolve to a definite non-zero value.
  return (
    <div
      ref={containerRef}
      data-testid="terminal-root"
      style={{ width: "100%", height: "100%", minHeight: 0 }}
    />
  );
}
