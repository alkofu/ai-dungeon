/**
 * Tests for useNavbarWidth hook.
 *
 * The hook depends on useSettings() — we mock SettingsContext so the hook
 * runs without a real provider or Tauri fs plugin. The pattern mirrors
 * AppLayout.test.tsx (module-level vi.mock with a factory).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// ── Module-level mocks ────────────────────────────────────────────────────────
// vi.mock calls are hoisted before imports by Vitest.

const { mockSettings, mockUpdateSettings } = vi.hoisted(() => {
  const _settings = {
    version: 1 as const,
    colorScheme: "auto" as "light" | "dark" | "auto",
    terminal: { fontSize: 13 },
    layout: { navbarWidth: 250 },
  };
  const _update = vi.fn().mockResolvedValue(undefined);
  return { mockSettings: _settings, mockUpdateSettings: _update };
});

vi.mock("../../settings/SettingsContext", () => ({
  useSettings: () => ({
    settings: mockSettings,
    updateSettings: mockUpdateSettings,
    saveError: null,
  }),
}));

import { useNavbarWidth, MIN_NAVBAR_WIDTH, MAX_NAVBAR_WIDTH } from "./useNavbarWidth";

describe("useNavbarWidth — constants", () => {
  it("exports MIN_NAVBAR_WIDTH = 160", () => {
    expect(MIN_NAVBAR_WIDTH).toBe(160);
  });

  it("exports MAX_NAVBAR_WIDTH = 600", () => {
    expect(MAX_NAVBAR_WIDTH).toBe(600);
  });
});

describe("useNavbarWidth — width reading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default state
    mockSettings.layout = { navbarWidth: 250 };
  });

  it("returns 250 when settings.layout.navbarWidth is 250", () => {
    mockSettings.layout = { navbarWidth: 250 };
    const { result } = renderHook(() => useNavbarWidth());
    expect(result.current.width).toBe(250);
  });

  it("returns 250 when settings.layout is absent (fallback to default)", () => {
    (mockSettings as { layout?: { navbarWidth?: number } }).layout = undefined;
    const { result } = renderHook(() => useNavbarWidth());
    expect(result.current.width).toBe(250);
  });

  it("returns persisted value when present and in range", () => {
    mockSettings.layout = { navbarWidth: 400 };
    const { result } = renderHook(() => useNavbarWidth());
    expect(result.current.width).toBe(400);
  });

  it("clamps a persisted value of 50 to 160 (min)", () => {
    mockSettings.layout = { navbarWidth: 50 };
    const { result } = renderHook(() => useNavbarWidth());
    expect(result.current.width).toBe(160);
  });

  it("clamps a persisted value of 9999 to 600 (max)", () => {
    mockSettings.layout = { navbarWidth: 9999 };
    const { result } = renderHook(() => useNavbarWidth());
    expect(result.current.width).toBe(600);
  });
});

describe("useNavbarWidth — setWidth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.layout = { navbarWidth: 250 };
  });

  it("setWidth(400) calls updateSettings with { layout: { navbarWidth: 400 } }", async () => {
    const { result } = renderHook(() => useNavbarWidth());
    await act(async () => {
      result.current.setWidth(400);
    });
    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ layout: { navbarWidth: 400 } });
    });
  });

  it("setWidth(50) calls updateSettings with { layout: { navbarWidth: 160 } } (clamped to min)", async () => {
    const { result } = renderHook(() => useNavbarWidth());
    await act(async () => {
      result.current.setWidth(50);
    });
    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ layout: { navbarWidth: 160 } });
    });
  });

  it("setWidth(9999) calls updateSettings with { layout: { navbarWidth: 600 } } (clamped to max)", async () => {
    const { result } = renderHook(() => useNavbarWidth());
    await act(async () => {
      result.current.setWidth(9999);
    });
    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith({ layout: { navbarWidth: 600 } });
    });
  });

  it("N rapid setWidth calls within 200ms debounce window produce only one updateSettings call", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useNavbarWidth());

    // Fire 5 rapid calls without advancing timers
    act(() => {
      result.current.setWidth(300);
      result.current.setWidth(310);
      result.current.setWidth(320);
      result.current.setWidth(330);
      result.current.setWidth(340);
    });

    // Not yet called — debounce window still open
    expect(mockUpdateSettings).not.toHaveBeenCalled();

    // Advance past the debounce window (200ms trailing)
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    // Only one call with the last value
    expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    expect(mockUpdateSettings).toHaveBeenCalledWith({ layout: { navbarWidth: 340 } });

    vi.useRealTimers();
  });
});
