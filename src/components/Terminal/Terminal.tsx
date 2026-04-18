import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export function Terminal() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({ convertEol: true });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // FitAddon.fit() returns silently when dimensions are zero (not a throw).
    // Disconnect observer before disposing terminal to prevent any queued
    // ResizeObserver callbacks from calling fit() on a disposed terminal.
    fitAddon.fit();

    // Write a static welcome banner so the integration is visually verifiable.
    // Note: '\u2014' is U+2014 EM DASH — match this exact character in tests.
    term.writeln("AI Dungeon Terminal \u2014 ready");

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, []);

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
