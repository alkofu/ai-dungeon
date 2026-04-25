import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface TerminalProps {
  // The caller supplies a stable UUID that identifies this PTY session. The
  // same sessionId across re-renders means the same shell; a different sessionId
  // triggers a full unmount/re-spawn via the useEffect dependency array.
  sessionId: string;
}

export function Terminal({ sessionId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

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

    // ── Async IIFE: spawn shell + subscribe to events ─────────────────────────
    void (async () => {
      const dims = fitAddon.proposeDimensions() ?? { cols: 80, rows: 24 };

      try {
        await invoke("pty_spawn", {
          sessionId,
          cols: dims.cols,
          rows: dims.rows,
        });
      } catch (err) {
        if (!cancelled) {
          term.writeln(`\r\n[failed to start shell: ${String(err)}]`);
        }
        return;
      }

      // If the component unmounted while pty_spawn was in flight, the cleanup
      // function already fired pty_kill (which found no session yet and returned
      // Ok). Now that the session exists on the backend, kill it explicitly so
      // the shell + reader thread are not orphaned.
      if (cancelled) {
        void invoke("pty_kill", { sessionId });
        return;
      }

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

      unlistenExit = await listen(`pty:exit:${sessionId}`, () => {
        term.writeln("\r\n[process exited]");
        // Remove the dead session from the backend HashMap. pty_kill is
        // idempotent (returns Ok when the session is absent), so this is safe
        // even if cleanup has already run.
        void invoke("pty_kill", { sessionId });
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
      unlistenOutput?.();
      unlistenExit?.();
      // Fire-and-forget: kill errors are non-fatal during teardown.
      void invoke("pty_kill", { sessionId });
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
