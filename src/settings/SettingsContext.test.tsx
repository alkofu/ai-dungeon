/**
 * Tests for SettingsProvider and useSettings hook.
 *
 * The fs mock is provided by the shared helper in test-utils/mockTauriFs.ts.
 * The persistence module is mocked via vi.doMock inside each test to control
 * load/save behaviour precisely.
 */

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFsMock } from "../test-utils/mockTauriFs";
import { DEFAULT_SETTINGS } from "./types";

// Import the shared fs mock so vi.mock hoisting fires for @tauri-apps/plugin-fs.
import "../test-utils/mockTauriFs";

const fsMock = installFsMock({ initialFile: JSON.stringify(DEFAULT_SETTINGS) });

afterEach(() => {
  fsMock.reset();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Provider null-render and load behaviour
// ---------------------------------------------------------------------------

describe("SettingsProvider", () => {
  it("renders null before loadSettings resolves, then renders children", async () => {
    // Use a deferred promise controlled via globalThis so vi.doMock factory
    // can reference it without closure-over-local-variable issues.
    let resolveLoad!: (s: typeof DEFAULT_SETTINGS) => void;
    (globalThis as Record<string, unknown>).__testLoadPromise__ = new Promise<
      typeof DEFAULT_SETTINGS
    >((res) => {
      resolveLoad = res;
    });

    vi.doMock("./persistence", () => ({
      loadSettings: vi.fn(
        () =>
          (globalThis as Record<string, unknown>).__testLoadPromise__ as Promise<
            typeof DEFAULT_SETTINGS
          >,
      ),
      saveSettings: vi.fn(() => Promise.resolve()),
    }));

    const { SettingsProvider } = await import("./SettingsContext");

    const { container } = render(
      <SettingsProvider>
        <div data-testid="child">Hello</div>
      </SettingsProvider>,
    );

    // Before resolution: provider returns null → nothing in the DOM
    expect(container.firstChild).toBeNull();

    // Resolve the load
    await act(async () => {
      resolveLoad(DEFAULT_SETTINGS);
      await (globalThis as Record<string, unknown>).__testLoadPromise__;
    });

    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("never renders children with DEFAULT_SETTINGS when a non-default file exists", async () => {
    const persistedSettings = { ...DEFAULT_SETTINGS, colorScheme: "dark" as const };

    vi.doMock("./persistence", () => ({
      loadSettings: vi.fn(() => Promise.resolve(persistedSettings)),
      saveSettings: vi.fn(() => Promise.resolve()),
    }));

    const { SettingsProvider, useSettings } = await import("./SettingsContext");

    const observedColorSchemes: string[] = [];

    function Observer() {
      const { settings } = useSettings();
      observedColorSchemes.push(settings.colorScheme);
      return null;
    }

    await act(async () => {
      render(
        <SettingsProvider>
          <Observer />
        </SettingsProvider>,
      );
    });

    // All observed values should be "dark" — never "auto" (the DEFAULT)
    expect(observedColorSchemes.length).toBeGreaterThan(0);
    for (const scheme of observedColorSchemes) {
      expect(scheme).toBe("dark");
    }
  });

  it("updateSettings calls saveSettings and re-renders consumers with merged state", async () => {
    const saveSettingsMock = vi.fn(() => Promise.resolve());

    vi.doMock("./persistence", () => ({
      loadSettings: vi.fn(() => Promise.resolve(DEFAULT_SETTINGS)),
      saveSettings: saveSettingsMock,
    }));

    const { SettingsProvider, useSettings } = await import("./SettingsContext");

    function Consumer() {
      const { settings, updateSettings } = useSettings();
      return (
        <div>
          <span data-testid="scheme">{settings.colorScheme}</span>
          <button
            onClick={() => {
              void updateSettings({ colorScheme: "dark" });
            }}
          >
            Set dark
          </button>
        </div>
      );
    }

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });

    expect(screen.getByTestId("scheme").textContent).toBe("auto");

    await act(async () => {
      screen.getByText("Set dark").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("scheme").textContent).toBe("dark");
    });

    expect(saveSettingsMock).toHaveBeenCalled();
  });

  it("updateSettings rejection does not mutate in-memory state", async () => {
    vi.doMock("./persistence", () => ({
      loadSettings: vi.fn(() => Promise.resolve(DEFAULT_SETTINGS)),
      saveSettings: vi.fn(() => Promise.reject(new Error("disk full"))),
    }));

    const { SettingsProvider, useSettings } = await import("./SettingsContext");

    function Consumer() {
      const { settings, updateSettings, saveError } = useSettings();
      return (
        <div>
          <span data-testid="scheme">{settings.colorScheme}</span>
          {saveError !== null && <span data-testid="save-error">{saveError.message}</span>}
          <button
            onClick={() => {
              void updateSettings({ colorScheme: "dark" }).catch(() => {});
            }}
          >
            Set dark
          </button>
        </div>
      );
    }

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });

    await act(async () => {
      screen.getByText("Set dark").click();
    });

    // State should remain "auto" since save failed
    await waitFor(() => {
      expect(screen.getByTestId("scheme").textContent).toBe("auto");
    });

    // saveError should be surfaced with the thrown message
    await waitFor(() => {
      expect(screen.getByTestId("save-error").textContent).toBe("disk full");
    });
  });

  it("updateSettings clears saveError on the next successful save", async () => {
    const saveSettingsMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);

    vi.doMock("./persistence", () => ({
      loadSettings: vi.fn(() => Promise.resolve(DEFAULT_SETTINGS)),
      saveSettings: saveSettingsMock,
    }));

    const { SettingsProvider, useSettings } = await import("./SettingsContext");

    function Consumer() {
      const { settings, updateSettings, saveError } = useSettings();
      return (
        <div>
          <span data-testid="scheme">{settings.colorScheme}</span>
          {saveError !== null && <span data-testid="save-error">{saveError.message}</span>}
          <button
            onClick={() => {
              void updateSettings({ colorScheme: "dark" }).catch(() => {});
            }}
          >
            Set dark
          </button>
          <button
            onClick={() => {
              void updateSettings({ colorScheme: "light" }).catch(() => {});
            }}
          >
            Set light
          </button>
        </div>
      );
    }

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });

    // First click: save fails → saveError is set, scheme stays "auto"
    await act(async () => {
      screen.getByText("Set dark").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("save-error").textContent).toBe("disk full");
    });
    expect(screen.getByTestId("scheme").textContent).toBe("auto");

    // Second click: save succeeds → saveError is cleared, scheme updates
    await act(async () => {
      screen.getByText("Set light").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("scheme").textContent).toBe("light");
    });
    expect(screen.queryByTestId("save-error")).toBeNull();
  });

  it("useSettings throws when called outside a provider", async () => {
    const { useSettings } = await import("./SettingsContext");

    // Suppress React's error boundary console.error output
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => {
      renderHook(() => useSettings());
    }).toThrow("useSettings must be used inside <SettingsProvider>");
    consoleSpy.mockRestore();
  });

  it("deep-merge: updateSettings({ terminal: { fontSize: 20 } }) preserves other terminal fields", async () => {
    type ExtendedSettings = typeof DEFAULT_SETTINGS & {
      terminal: { fontSize: number; _testKey: string };
    };
    const initialSettings: ExtendedSettings = {
      ...DEFAULT_SETTINGS,
      terminal: { fontSize: 13, _testKey: "preserved" },
    };

    vi.doMock("./persistence", () => ({
      loadSettings: vi.fn(() =>
        Promise.resolve(initialSettings as unknown as typeof DEFAULT_SETTINGS),
      ),
      saveSettings: vi.fn(() => Promise.resolve()),
    }));

    const { SettingsProvider, useSettings } = await import("./SettingsContext");

    let capturedSettings: ExtendedSettings | null = null;

    function Consumer() {
      const { settings, updateSettings } = useSettings();
      capturedSettings = settings as unknown as ExtendedSettings;
      return (
        <button
          onClick={() => {
            void updateSettings({ terminal: { fontSize: 20 } });
          }}
        >
          Change font
        </button>
      );
    }

    await act(async () => {
      render(
        <SettingsProvider>
          <Consumer />
        </SettingsProvider>,
      );
    });

    await act(async () => {
      screen.getByText("Change font").click();
    });

    await waitFor(() => {
      expect(capturedSettings?.terminal.fontSize).toBe(20);
    });

    // The hypothetical _testKey must be preserved (merge, not replace)
    const captured = capturedSettings as ExtendedSettings | null;
    expect(captured?.terminal._testKey).toBe("preserved");
  });
});
