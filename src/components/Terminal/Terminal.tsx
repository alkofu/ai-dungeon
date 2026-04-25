import { useEffect, useMemo, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);

  // One stable session ID per Terminal mount lifetime.
  const sessionId = useMemo(() => crypto.randomUUID(), []);

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

    // ── Terminal & FitAddon ───────────────────────────────────────────────────
    const term = new XTerm();
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

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

      unlistenExit = await listen(`pty:exit:${sessionId}`, () => {
        term.writeln("\r\n[process exited]");
      });

      if (cancelled) return;

      // ── Register onData: forward keystrokes to the PTY ─────────────────────
      // Encode the xterm string to UTF-8 bytes via TextEncoder, then base64.
      // This guarantees binary fidelity for alt-key sequences, mouse reporting,
      // paste of binary content, and non-UTF-8 readline responses. (M-4)
      const encoder = new TextEncoder();
      onDataDisposable = term.onData((data) => {
        const bytes = encoder.encode(data);
        // Chunked base64 encoding to handle large paste payloads safely.
        // String.fromCharCode.apply has a stack limit; process in 8 KiB chunks.
        const CHUNK = 8192;
        let bin = "";
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          const chunk = bytes.subarray(offset, offset + CHUNK);
          bin += String.fromCharCode.apply(null, chunk as unknown as number[]);
        }
        const data_b64 = btoa(bin);

        void invoke("pty_write", { sessionId, data_b64 });
      });

      isReadyRef.current = true;
    })();

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      cancelled = true;
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
  return (
    <div
      ref={containerRef}
      data-testid="terminal-root"
      style={{ width: "100%", height: "100%", minHeight: 0 }}
    />
  );
}
