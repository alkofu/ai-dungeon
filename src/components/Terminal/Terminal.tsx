/*
 * Font and locale prerequisites
 * ──────────────────────────────────────────────────────────────────────────────
 * This component depends on three guarantees that span multiple files:
 *
 * 1. FONT PRELOAD — `webFontsAddon.loadFonts(['MesloLGS NF'])` is awaited before
 *    `term.open()` so xterm measures glyph widths against MesloLGS NF, not the
 *    fallback monospace. Inverting this order causes permanent alignment damage
 *    that persists for the lifetime of the terminal instance.
 *
 *    Precondition: `src/styles/fonts.css` MUST be imported at module scope from
 *    `src/main.tsx`. The @xterm/addon-web-fonts API: loadFonts(string[]) only
 *    resolves FontFace[] for @font-face rules already registered in
 *    document.fonts. The module-scope import is what populates document.fonts
 *    before any component code runs (Vite resolves CSS imports synchronously at
 *    module evaluation). Without this import, the addon rejects with the string
 *    error `'font family "MesloLGS NF" not registered in document.fonts'`.
 *
 *    Alternative: pass FontFace constructor objects directly to loadFonts() to
 *    bypass the document.fonts precondition entirely. This is documented here
 *    as an escape hatch if the import-order guarantee is ever broken.
 *
 * 2. GEOMETRY — `letterSpacing: 0`, `lineHeight: 1`, no `customGlyphs`. Both
 *    values are load-bearing for Nerd Font alignment. `customGlyphs` only affects
 *    block/box-drawing characters and has no effect under the DOM renderer; do
 *    NOT enable it. These are pinned in the XTerm constructor below.
 *
 * 3. UTF-8 LOCALE — `src-tauri/src/pty.rs` exports `LC_ALL` set to a UTF-8
 *    locale on every Unix spawn (see `resolve_pty_utf8_locale`). Without this,
 *    Powerlevel10k prompt rendering and many non-ASCII glyphs degrade. The Rust
 *    unit tests in `pty.rs::tests` enforce the resolution priority.
 */
import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebFontsAddon } from "@xterm/addon-web-fonts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  parseSessionContextPayload,
  parseOsc7Payload,
  parseOsc7337Payload,
} from "../../types/sessionPayload";
import type { SessionContext } from "../../types/session";

interface TerminalProps {
  // The caller supplies a stable UUID that identifies this PTY session. The
  // same sessionId across re-renders means the same shell; a different sessionId
  // triggers a full unmount/re-spawn via the useEffect dependency array.
  sessionId: string;
  // Called whenever an OSC 6800 payload is received and successfully parsed.
  // Fires with a fully-formed SessionContext (full replacement).
  // Captured via a ref so the OSC handler always uses the latest version without
  // needing to be in the useEffect dependency array (which would restart the PTY
  // session on every re-render of the parent).
  onSessionContextChange?: (ctx: SessionContext) => void;
  // Called whenever an OSC 7 or OSC 7337 payload is received and successfully parsed.
  // Fires with a partial patch that is merged into the existing SessionContext record.
  onSessionContextPatch?: (patch: Partial<SessionContext>) => void;
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

export function Terminal({
  sessionId,
  onSessionContextChange,
  onSessionContextPatch,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Keep refs to the latest callbacks so the OSC handlers always call the current
  // version without adding them to the useEffect dependency array (which would
  // cause the effect — and therefore the PTY session — to restart every time the
  // parent re-renders). Assignments run on every render (component-top scope).
  const onSessionContextChangeRef = useRef(onSessionContextChange);
  onSessionContextChangeRef.current = onSessionContextChange;
  const onSessionContextPatchRef = useRef(onSessionContextPatch);
  onSessionContextPatchRef.current = onSessionContextPatch;

  useEffect(() => {
    if (!containerRef.current) return;

    // Track whether the async spawn has completed so the ResizeObserver
    // callback and onData handler know whether the PTY is ready.
    const isReadyRef = { current: false };

    // Track whether cleanup has run so the async IIFEs can bail early.
    let cancelled = false;

    // Collect IPC unlisten functions to call during cleanup.
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;

    // Collect the onData disposable for cleanup.
    let onDataDisposable: { dispose: () => void } | undefined;

    // Collect the OSC handler disposables for cleanup.
    let oscDisposable: { dispose: () => void } | undefined;
    let osc7Handler: { dispose: () => void } | undefined;
    let osc7337Handler: { dispose: () => void } | undefined;

    // Buffer for keystrokes that arrive before the PTY is ready. Each entry is
    // a discrete xterm onData string and is encoded + sent independently to
    // preserve per-keystroke handling semantics.
    const pendingWrites: string[] = [];

    // ── Terminal, FitAddon, and WebFontsAddon ─────────────────────────────────
    //
    // fontFamily: '"MesloLGS NF", monospace' — Powerlevel10k-recommended Nerd
    // Font. Falls back to system monospace if vendored TTFs are unavailable.
    // fontSize: 13, lineHeight: 1, letterSpacing: 0 — pinned to the values
    // documented by xterm.js for correct Nerd Font / powerline glyph alignment.
    // DO NOT change lineHeight or letterSpacing without re-testing all powerline
    // glyphs. customGlyphs is intentionally NOT set (default false) — it only
    // affects block/box-drawing characters and has no effect under the DOM
    // renderer; it does not fix powerline glyphs.
    // minimumContrastRatio: 1 — disables xterm's automatic colour adjustment,
    // which can shift theme colours in ways that conflict with p10k palettes.
    const term = new XTerm({
      fontFamily: '"MesloLGS NF", monospace',
      fontSize: 13,
      lineHeight: 1,
      letterSpacing: 0,
      minimumContrastRatio: 1,
    });
    const fitAddon = new FitAddon();
    const webFontsAddon = new WebFontsAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webFontsAddon);

    // Allow the global tab-switching hotkeys to escape xterm.
    // Returning false tells xterm "do not handle this event"; the event
    // continues to propagate so the document-level useHotkeys listener
    // registered in AppLayout (attached at document.documentElement) can
    // act on it.
    // The set covers the eleven combos in scope: mod+ArrowLeft,
    // mod+ArrowRight, and mod+1..mod+9. mod+0 is intentionally NOT in
    // this set (matches AppLayout's hotkey registrations).
    //
    // The `shiftKey || altKey` early-return is load-bearing: Mantine's
    // parseHotkey for "mod+1" demands { shift: false, alt: false }, so
    // useHotkeys does NOT fire for combos like mod+Shift+1 or
    // mod+Alt+ArrowLeft. If we returned false for those here, the combo
    // would be silently swallowed (xterm ignores it AND useHotkeys
    // ignores it). Real-world impact: tmux/screen users routinely use
    // Ctrl+Shift+1..9 for window selection inside the terminal — those
    // must reach the shell. So we restrict interception to bare mod+key
    // (no shift, no alt), which is exactly the eleven combos useHotkeys
    // is registered for.
    //
    // DIGIT_KEYS is an explicit Set rather than a string-range comparison
    // (event.key >= "1" && event.key <= "9"), which is technically correct
    // but non-obvious. The set documents intent and matches the nine
    // mod+1..mod+9 combos registered in AppLayout one-for-one.
    const DIGIT_KEYS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return true;
      // Only intercept bare mod+key — reject any extra modifiers so that
      // mod+Shift+... and mod+Alt+... still reach xterm and the shell.
      if (event.shiftKey || event.altKey) return true;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        return false;
      }
      if (DIGIT_KEYS.has(event.key)) {
        return false;
      }
      return true;
    });

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

    // ── Register onData synchronously (Invariant I2) ──────────────────────────
    // Registered here — BEFORE the font-load IIFE and the spawn IIFE — so that
    // keystrokes typed during the font-load or spawn window are captured into
    // pendingWrites rather than dropped. While isReadyRef.current is false,
    // keystrokes are buffered. Once the PTY is ready, keystrokes are forwarded
    // live. DO NOT move this registration inside either async IIFE.
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
    // Run synchronously here (Invariant I3): the spawn IIFE reads
    // fitAddon.proposeDimensions() synchronously to compute initial cols/rows.
    // fit() running before fonts are loaded computes cell dimensions against
    // the fallback font; this is acceptable because xterm re-measures inside
    // term.open() against the resolved font. Any one-cell drift self-corrects
    // via the ResizeObserver after term.open().
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

    // ── Two concurrent async IIFEs ────────────────────────────────────────────
    //
    // (a) Font-load IIFE — awaits MesloLGS NF, then opens the terminal and
    //     registers OSC handlers. This IIFE must complete before xterm can
    //     render output, but it does NOT block the spawn IIFE from starting.
    //
    // (b) Spawn IIFE (below) — awaits pty_spawn, subscribes to PTY events,
    //     and flushes buffered keystrokes. Runs concurrently with (a).
    //
    // The two IIFEs are independent — neither awaits the other. Both check
    // `cancelled` after every await to handle StrictMode fast-unmount.
    //
    // Invariant I2 (onData synchronous) and I3 (fit + observe synchronous)
    // are satisfied by the registrations above, before either IIFE starts.

    // ── (a) Font-load + open + OSC-register IIFE ─────────────────────────────
    void (async () => {
      // Await font load BEFORE term.open() so xterm measures glyph widths
      // against MesloLGS NF, not the fallback monospace. This ordering is
      // load-bearing per xterm.js docs and MUST NOT be reordered.
      //
      // Precondition: src/styles/fonts.css must be imported at module scope
      // in src/main.tsx. loadFonts(['MesloLGS NF']) only resolves FontFace[]
      // for @font-face rules already in document.fonts. Without that import,
      // the addon rejects with the string error
      // `'font family "MesloLGS NF" not registered in document.fonts'`.
      //
      // Alternative: pass FontFace constructor objects to loadFonts() directly
      // to bypass the document.fonts precondition:
      //   new FontFace('MesloLGS NF', 'url(/fonts/MesloLGS NF Regular.ttf)', { weight: '400' })
      // This is documented here as an escape hatch for future maintainers.
      try {
        await webFontsAddon.loadFonts(["MesloLGS NF"]);
      } catch (err) {
        console.warn(
          "[Terminal] webFontsAddon.loadFonts rejected — falling back to system monospace font:",
          err,
        );
        // Fall through: term.open() below will use the fallback fontFamily.
      }

      // Re-check cancelled immediately after await — a StrictMode fast unmount
      // during font load must not call term.open() on a disposed terminal.
      if (cancelled) return;

      term.open(containerRef.current!);

      // ── OSC 6800 handler (Invariant I1: must be after term.open) ─────────────
      // Intercepts OSC 6800 sequences emitted by the TPK toolkit to surface
      // session context in the per-tab UI. The handler returns true so xterm.js
      // does not chain the sequence to its default handler (which would print or
      // ignore it). The dispatch is wrapped in queueMicrotask to guarantee it
      // lands outside the current synchronous stack (term.write() fires OSC
      // handlers synchronously, which would violate React's render rules).
      oscDisposable = term.parser.registerOscHandler(6800, (data: string) => {
        const ctx = parseSessionContextPayload(data);
        if (ctx) {
          queueMicrotask(() => onSessionContextChangeRef.current?.(ctx));
        }
        return true;
      });

      // ── OSC 7 handler ─────────────────────────────────────────────────────────
      // Intercepts OSC 7 sequences (file:// URI carrying the shell's CWD).
      // Delegates all parsing/validation to parseOsc7Payload — handler body is
      // a thin call-site only.
      osc7Handler = term.parser.registerOscHandler(7, (data): boolean => {
        const result = parseOsc7Payload(data);
        if (result) queueMicrotask(() => onSessionContextPatchRef.current?.(result));
        return true;
      });

      // ── OSC 7337 handler ──────────────────────────────────────────────────────
      // Intercepts OSC 7337 sequences (git context: bare repo name + branch).
      // Delegates all parsing/validation to parseOsc7337Payload — handler body is
      // a thin call-site only.
      osc7337Handler = term.parser.registerOscHandler(7337, (data): boolean => {
        const result = parseOsc7337Payload(data);
        if (result) queueMicrotask(() => onSessionContextPatchRef.current?.(result));
        return true;
      });
    })();

    // ── (b) Spawn IIFE: subscribe to events after spawn resolves ─────────────
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
      oscDisposable?.dispose(); // OSC 6800
      osc7Handler?.dispose(); // OSC 7
      osc7337Handler?.dispose(); // OSC 7337
      onDataDisposable?.dispose();
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
