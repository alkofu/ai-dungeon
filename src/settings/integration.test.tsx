/**
 * End-to-end integration test for the settings system.
 *
 * This test exercises the full chain:
 *   SettingsProvider → MantineThemeBridge → AppLayout → SettingsModal
 *
 * The Tauri fs plugin is mocked via the shared installFsMock helper.
 * The Tauri core/event APIs are mocked to prevent PTY-related errors.
 */

// ── Tauri fs mock (must be at module level, before imports) ───────────────────
import { installFsMock } from "../test-utils/mockTauriFs";
import { DEFAULT_SETTINGS } from "./types";

const fsMock = installFsMock({ initialFile: JSON.stringify(DEFAULT_SETTINGS) });

// ── Tauri core and event mocks ────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(1),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation(() => Promise.resolve(vi.fn())),
}));

// ── xterm mocks (AppLayout renders Terminal which uses xterm) ─────────────────
vi.mock("@xterm/xterm", () => {
  const _vi = vi;
  function MockTerminal() {
    return {
      write: _vi.fn(),
      writeln: _vi.fn(),
      open: _vi.fn(),
      loadAddon: _vi.fn(),
      dispose: _vi.fn(),
      onData: _vi.fn().mockReturnValue({ dispose: _vi.fn() }),
      parser: { registerOscHandler: _vi.fn().mockReturnValue({ dispose: _vi.fn() }) },
      attachCustomKeyEventHandler: _vi.fn(),
      options: { fontSize: 13 },
    };
  }
  return { Terminal: _vi.fn().mockImplementation(MockTerminal) };
});

vi.mock("@xterm/addon-fit", () => {
  const _vi = vi;
  function MockFitAddon() {
    return {
      fit: _vi.fn(),
      proposeDimensions: _vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    };
  }
  return { FitAddon: _vi.fn().mockImplementation(MockFitAddon) };
});

vi.mock("@xterm/addon-web-fonts", () => {
  const _vi = vi;
  function MockWebFontsAddon() {
    return {
      loadFonts: _vi.fn().mockResolvedValue([{}]),
    };
  }
  return { WebFontsAddon: _vi.fn().mockImplementation(MockWebFontsAddon) };
});

vi.mock("../components/layout/useModifierHeld", async (importOriginal) => {
  const original = await importOriginal<typeof import("../components/layout/useModifierHeld")>();
  return { ...original, isMacPlatform: () => true };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import React from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { SettingsProvider, useSettings } from "./SettingsContext";
import { AppLayout } from "../components/layout/AppLayout";
import { _clearSpawnChainForTesting } from "../components/Terminal/Terminal";

// MantineThemeBridge: mirrors the production version in src/main.tsx.
// Cannot import from main.tsx because it is the app entry point (not exported).
// env="test" bypasses Mantine's JS animation timers so Modal content renders
// immediately in jsdom, making RTL queries work without advancing fake timers.
function MantineThemeBridge({ children }: { children: React.ReactNode }) {
  const { settings } = useSettings();
  const forceColorScheme = settings.colorScheme === "auto" ? undefined : settings.colorScheme;
  return (
    <MantineProvider env="test" forceColorScheme={forceColorScheme}>
      {children}
    </MantineProvider>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderIntegration() {
  return render(
    <SettingsProvider>
      <MantineThemeBridge>
        <AppLayout
          cards={[]}
          onAddTerminalCard={vi.fn()}
          onAddDungeonCard={vi.fn()}
          onRemoveCard={vi.fn()}
          activeId={null}
          onActiveIdChange={vi.fn()}
          sessionContext={{}}
          onSessionContextChange={vi.fn()}
          shellContext={{}}
          onShellContextChange={vi.fn()}
          readyCardIds={new Set()}
          onCardReady={vi.fn()}
        />
      </MantineThemeBridge>
    </SettingsProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Settings integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMock.reset();
    _clearSpawnChainForTesting();
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }) as unknown as typeof ResizeObserver;
  });

  it("renders AppLayout after SettingsProvider loads (provider moves past null window)", async () => {
    await act(async () => {
      renderIntegration();
    });

    // Once the provider finishes loading, the gear button from AppLayout is in the DOM.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /open settings/i })).toBeInTheDocument();
    });
  });

  it("changing color-scheme to Dark writes settings to disk and updates data-mantine-color-scheme attribute", async () => {
    const user = userEvent.setup();

    await act(async () => {
      renderIntegration();
    });

    // Wait for provider to finish loading
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /open settings/i })).toBeInTheDocument();
    });

    // Open the settings modal
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /open settings/i }));
    });

    // Change color scheme to Dark
    const colorSchemeSelect = screen.getByRole("combobox", { name: /color scheme/i });
    await act(async () => {
      await user.click(colorSchemeSelect);
    });
    await act(async () => {
      await user.click(screen.getByRole("option", { name: "Dark" }));
    });

    // Assert the write was recorded
    await waitFor(() => {
      expect(fsMock.writes.length).toBeGreaterThan(0);
    });

    const lastWrite = fsMock.writes[fsMock.writes.length - 1];
    const written = JSON.parse(lastWrite.contents) as typeof DEFAULT_SETTINGS;
    expect(written.colorScheme).toBe("dark");

    // Assert Mantine applied the color scheme to the HTML element.
    // Mantine v9 MantineProvider with forceColorScheme sets data-mantine-color-scheme
    // on the <html> element.
    await waitFor(() => {
      const htmlEl = document.documentElement;
      expect(htmlEl.getAttribute("data-mantine-color-scheme")).toBe("dark");
    });
  });

  it("changing terminal font size writes settings with updated fontSize to disk", async () => {
    const user = userEvent.setup();

    await act(async () => {
      renderIntegration();
    });

    // Wait for provider to finish loading
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /open settings/i })).toBeInTheDocument();
    });

    // Open the settings modal
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /open settings/i }));
    });

    // Mantine NumberInput renders type="text" with inputmode="decimal" — locate via label.
    const fontSizeLabel = within(document.body).getByText(/terminal font size/i);
    const fontSizeInputId = fontSizeLabel.getAttribute("for");
    const fontSizeInput = fontSizeInputId
      ? (document.getElementById(fontSizeInputId) as HTMLInputElement)
      : null;
    expect(fontSizeInput).not.toBeNull();
    await act(async () => {
      await user.clear(fontSizeInput!);
      await user.type(fontSizeInput!, "16");
      await user.tab();
    });

    // Assert the write was recorded
    await waitFor(() => {
      const hasWrite = fsMock.writes.some((w) => {
        try {
          const parsed = JSON.parse(w.contents) as typeof DEFAULT_SETTINGS;
          return parsed.terminal.fontSize === 16;
        } catch {
          return false;
        }
      });
      expect(hasWrite).toBe(true);
    });
  });
});
