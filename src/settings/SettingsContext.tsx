/**
 * SettingsProvider and useSettings hook.
 *
 * Design note — no flash of default settings on cold start:
 * The provider returns `null` from its render until `loadSettings()` resolves.
 * This means consumers (including MantineThemeBridge, which sets the Mantine
 * color scheme) are never mounted while settings are unknown. If the user has
 * persisted a dark color scheme, they see dark on the very first paint — there
 * is no visible flash from light to dark. The null window is bounded by a
 * single readTextFile round-trip (low single-digit ms in practice) and a brief
 * blank screen is preferable to a flash of the wrong theme.
 *
 * isLoading is intentionally absent from the public context value because the
 * null-return replaces it — consumers never observe a loading state.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { loadSettings, saveSettings } from "./persistence";
import type { Settings } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// DeepPartial: makes all properties (and nested properties) optional.
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

interface SettingsContextValue {
  settings: Settings;
  updateSettings: (patch: DeepPartial<Settings>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Deep-merge helper (inline, no lodash)
//
// Two-level merge is sufficient for v1's { colorScheme, terminal: { fontSize } }
// shape. Any future nested setting must extend this helper to handle its level.
// ---------------------------------------------------------------------------

function deepMergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  return {
    ...current,
    ...patch,
    // Merge the terminal sub-object rather than replacing it, so that future
    // fields under terminal (e.g. fontFamily) are preserved when only fontSize
    // is patched.
    terminal:
      patch.terminal !== undefined ? { ...current.terminal, ...patch.terminal } : current.terminal,
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void loadSettings().then((loaded) => {
      setSettings(loaded);
    });
  }, []);

  const updateSettings = useCallback(
    async (patch: DeepPartial<Settings>): Promise<void> => {
      if (settings === null) return;
      const merged = deepMergeSettings(settings, patch);
      // Only update React state on successful persistence — a write failure must
      // not leave the UI showing settings that are not on disk.
      await saveSettings(merged);
      setSettings(merged);
    },
    [settings],
  );

  const contextValue = useMemo(
    () => (settings === null ? null : { settings, updateSettings }),
    [settings, updateSettings],
  );

  // Return null until loadSettings resolves — this prevents any consumer from
  // observing DEFAULT_SETTINGS if a persisted file with different values exists.
  if (contextValue === null) return null;

  return <SettingsContext.Provider value={contextValue}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (ctx === null) {
    throw new Error("useSettings must be used inside <SettingsProvider>");
  }
  return ctx;
}
