import { useEffect, useRef, useState } from "react";

// TypeScript's bundled lib.dom.d.ts does not declare userAgentData or
// NavigatorUAData. Declare a minimal local ambient type so this module
// compiles under strict: true without an extra .d.ts file. If a future
// lib.dom.d.ts version adds these declarations, this local interface will
// structurally subtype it and continue to compile with no changes required.
// Minimal subset — only 'platform' is needed here. Full interface: https://wicg.github.io/ua-client-hints/
interface MinimalNavigatorUAData {
  platform?: string;
}
type NavigatorWithUAData = Navigator & { userAgentData?: MinimalNavigatorUAData };

/**
 * Returns true when the current platform is macOS (or iOS/iPadOS).
 *
 * Detection uses a four-step layered strategy that is safe under
 * TypeScript strict:true and across browsers that may not expose
 * navigator.userAgentData (Firefox, Safari):
 *   1. SSR guard: if navigator is undefined, return false.
 *   2. navigator.userAgentData?.platform === "macOS" (Chromium-based browsers).
 *   3. navigator.platform matching /Mac|iPhone|iPad|iPod/ (legacy, non-empty only).
 *   4. navigator.userAgent matching /Mac OS X|Macintosh/i (final UA fallback).
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;

  const nav = navigator as NavigatorWithUAData;

  if (nav.userAgentData?.platform === "macOS") return true;

  // navigator.platform is deprecated and may be empty in future browsers,
  // so only use it when the value is non-empty.
  if (navigator.platform.length > 0 && /Mac|iPhone|iPad|iPod/.test(navigator.platform)) return true;

  if (/Mac OS X|Macintosh/i.test(navigator.userAgent)) return true;

  return false;
}

/**
 * Returns true while the platform-idiomatic modifier key is held down for
 * at least 250 milliseconds.
 *
 * On macOS the watched key is "Meta" (Cmd); elsewhere it is "Control".
 * This is a UX display convention matching the platform's idiomatic shortcut
 * notation. The underlying mod+ hotkey (registered via useHotkeys in
 * AppLayout) accepts either modifier on any platform — the watched key here
 * is only used to decide when to reveal shortcut tooltips.
 *
 * The 250 ms hold delay prevents a tooltip flash during a fast Cmd+N press.
 * State is cleared on keyup, window blur, and document visibilitychange so
 * tooltips are never stuck when the user Cmd-Tabs away.
 *
 * Listeners attach exactly once via a single useEffect with [] dependencies
 * and are removed on unmount.
 */
export function useModifierHeld(): boolean {
  const [pressed, setPressed] = useState<boolean>(false);
  // Cache the watched key in a ref so the empty-dep effect closure always
  // reads the value determined at mount time — no re-registering listeners.
  const watchedKeyRef = useRef<string>(isMacPlatform() ? "Meta" : "Control");
  // timerRef holds the pending setTimeout handle, or null when no timer is
  // scheduled. window.setTimeout returns number (not NodeJS.Timeout), which
  // is required so the ref type is number | null and clearTimeout is happy.
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const watchedKey = watchedKeyRef.current;

    function clearPendingTimer() {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== watchedKey) return;
      // event.repeat === true means the OS is auto-repeating the key — do not
      // start a fresh timer on every repeat tick.
      if (event.repeat) return;
      // timerRef.current !== null means a timer is already pending.
      // We deliberately do NOT guard on `pressed === false` here: `pressed` is
      // captured by the empty-deps closure and would always read its initial
      // value of false (stale closure). The timerRef guard is the real
      // idempotency mechanism.
      if (timerRef.current !== null) return;

      timerRef.current = window.setTimeout(() => {
        setPressed(true);
        timerRef.current = null;
      }, 250);
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key !== watchedKey) return;
      clearPendingTimer();
      setPressed(false);
    }

    function onBlur() {
      clearPendingTimer();
      setPressed(false);
    }

    function onVisibilityChange() {
      if (document.hidden) {
        clearPendingTimer();
        setPressed(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearPendingTimer();
    };
    // Listeners attach exactly once at mount; there are no reactive values
    // that should cause re-registration.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return pressed;
}
