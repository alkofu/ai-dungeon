/**
 * useNavbarWidth — reads, clamps, and persists the sidebar width.
 *
 * The hook owns the debounce for persistence writes (200ms trailing) so that
 * rapid setWidth calls (e.g. from keyboard repeat) produce only one
 * updateSettings call rather than one per keydown event.
 *
 * The pointer-drag path calls setWidth once on pointerup (NavbarResizer's
 * onCommit), so the debounce has no observable effect there — the single
 * call fires after the 200ms window anyway.
 */

import { useCallback, useEffect, useRef } from "react";
import { useSettings } from "../../settings/SettingsContext";

export const MIN_NAVBAR_WIDTH = 160;
export const MAX_NAVBAR_WIDTH = 600;
const DEFAULT_NAVBAR_WIDTH = 250;
const DEBOUNCE_MS = 200;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export interface UseNavbarWidthResult {
  /** The current clamped navbar width in pixels. */
  width: number;
  /**
   * Set and persist a new navbar width. The value is clamped to [MIN, MAX]
   * before persisting. Rapid calls are debounced — only the last call within
   * the 200ms window triggers updateSettings.
   */
  setWidth: (next: number) => void;
  MIN: typeof MIN_NAVBAR_WIDTH;
  MAX: typeof MAX_NAVBAR_WIDTH;
}

export function useNavbarWidth(): UseNavbarWidthResult {
  const { settings, updateSettings } = useSettings();

  const persistedWidth = settings.layout?.navbarWidth ?? DEFAULT_NAVBAR_WIDTH;
  // Note: `isValidSettings` accepts any finite number for `navbarWidth`, including
  // out-of-range values. Clamping to [MIN, MAX] is this hook's responsibility, not
  // the validator's. A hand-edited file with an out-of-range value renders correctly
  // (clamped), but the persisted value stays unconverted until the user next resizes.
  const width = clamp(persistedWidth, MIN_NAVBAR_WIDTH, MAX_NAVBAR_WIDTH);

  // Debounce timer ref — cleared and reset on each setWidth call.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // updateSettings ref — keeps the debounced callback current without adding
  // updateSettings to the dependency array (avoids stale-closure issues).
  const updateSettingsRef = useRef(updateSettings);
  useEffect(() => {
    updateSettingsRef.current = updateSettings;
  }, [updateSettings]);

  // Clear any pending debounce timer on unmount to prevent calling
  // updateSettings after the component tree has been torn down.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = clamp(next, MIN_NAVBAR_WIDTH, MAX_NAVBAR_WIDTH);
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void updateSettingsRef.current({ layout: { navbarWidth: clamped } });
    }, DEBOUNCE_MS);
  }, []);

  return { width, setWidth, MIN: MIN_NAVBAR_WIDTH, MAX: MAX_NAVBAR_WIDTH };
}
