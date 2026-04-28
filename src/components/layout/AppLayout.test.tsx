vi.mock("@xterm/xterm", () => {
  // Each instance gets its own fresh spies so tests can introspect per-instance
  // writeln calls across multiple mounts. The `_vi` reference satisfies the
  // consistent-function-scoping rule by capturing a value from the outer closure.
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
  return { Terminal: vi.fn().mockImplementation(MockTerminal) };
});

// Mock SettingsContext so AppLayout (which renders SettingsModal) can call
// useSettings() without a real provider or Tauri fs plugin. The default
// settings match DEFAULT_SETTINGS so all existing tests are unaffected.
vi.mock("../../settings/SettingsContext", () => ({
  useSettings: () => ({
    settings: {
      version: 1,
      colorScheme: "auto",
      terminal: { fontSize: 13 },
    },
    updateSettings: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@xterm/addon-fit", () => {
  const _vi = vi;
  function MockFitAddon() {
    return {
      fit: _vi.fn(),
      proposeDimensions: _vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    };
  }
  return { FitAddon: vi.fn().mockImplementation(MockFitAddon) };
});

vi.mock("@xterm/addon-web-fonts", () => {
  const _vi = vi;
  function MockWebFontsAddon() {
    return {
      loadFonts: _vi.fn().mockResolvedValue([{}]),
    };
  }
  return { WebFontsAddon: vi.fn().mockImplementation(MockWebFontsAddon) };
});

// Default: pty_spawn resolves to numeric generation 1 (consistent with Step 5).
// The existing flex-contract test renders AppLayout with no cards so invoke is
// never called — this change is a no-op for that test.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(1),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation(() => Promise.resolve(vi.fn())),
}));

// SHORTCUT_GLYPH in SessionCard.tsx is a module-level constant evaluated at
// import time. Mock isMacPlatform to return true so the constant is "⌘" in
// every test in this file (no test here expects "Ctrl+").
vi.mock("./useModifierHeld", async (importOriginal) => {
  const original = await importOriginal<typeof import("./useModifierHeld")>();
  return { ...original, isMacPlatform: () => true };
});

import React from "react";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test-utils/render";
import { AppLayout } from "./AppLayout";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { _clearSpawnChainForTesting } from "../Terminal/Terminal";

type AnyMock = ReturnType<typeof vi.fn>;

// ── Session-aware mock builder ────────────────────────────────────────────────
// Mirrors the Step 1 pattern from Terminal.test.tsx. Install per-test via
// mockInvoke.mockImplementation(...); tear down is handled by beforeEach reset.
function installSessionAwareMock(mockInvoke: AnyMock) {
  const liveSessions = new Set<string>();
  const sessionGenerations = new Map<string, number>();
  let nextGeneration = 0;

  mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "pty_spawn") {
      const sid = args["sessionId"] as string;
      if (liveSessions.has(sid)) {
        throw new Error(`session already exists: ${sid}`);
      }
      nextGeneration += 1;
      liveSessions.add(sid);
      sessionGenerations.set(sid, nextGeneration);
      return nextGeneration;
    }
    if (cmd === "pty_kill") {
      const sid = args["sessionId"] as string;
      const gen = args["generation"] as number | undefined;
      if (gen === undefined || sessionGenerations.get(sid) === gen) {
        liveSessions.delete(sid);
        sessionGenerations.delete(sid);
      }
      return undefined;
    }
    if (cmd === "pty_write") {
      const sid = args["sessionId"] as string;
      if (!liveSessions.has(sid)) {
        throw new Error(`pty write failed: session not found: ${sid}`);
      }
      return undefined;
    }
    return undefined;
  });
}

describe("AppLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear the module-level spawn-chain Map so prior tests' promises do not
    // block subsequent tests' spawn calls.
    _clearSpawnChainForTesting();
    // Restore default invoke behaviour (numeric generation 1) after tests that
    // install a session-aware implementation.
    (invoke as unknown as AnyMock).mockResolvedValue(1);

    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }) as unknown as typeof ResizeObserver;
  });

  // ── Pre-existing flex-contract regression test (PR #22) ───────────────────
  // Must be preserved verbatim — it is a load-bearing regression guard.
  it("applies flex:1 and minWidth:0 to the AppShell root element", () => {
    const { container } = renderWithProviders(
      <AppLayout
        cards={[]}
        onAddCard={vi.fn()}
        onRemoveCard={vi.fn()}
        activeId={null}
        onActiveIdChange={vi.fn()}
        sessionContext={{}}
        onSessionContextChange={vi.fn()}
        shellContext={{}}
        onShellContextChange={vi.fn()}
      />,
    );

    // m_89ab340 is the stable CSS-module class Mantine assigns to the AppShell root div.
    const appShellRoot = container.querySelector(".m_89ab340");
    expect(appShellRoot).not.toBeNull();
    // jsdom normalises `flex: 1` to the longhand `"1 1 0%"`.
    expect((appShellRoot as HTMLElement).style.flex).not.toBe("");
    expect((appShellRoot as HTMLElement).style.flexGrow).toBe("1");
    expect((appShellRoot as HTMLElement).style.minWidth).toBe("0px");
  });

  // ── Multi-card integration test (Step 3) ──────────────────────────────────

  it("renders multiple cards under StrictMode without surfacing pty errors in any terminal", async () => {
    const mockInvoke = invoke as unknown as AnyMock;
    installSessionAwareMock(mockInvoke);

    await act(async () => {
      renderWithProviders(
        <React.StrictMode>
          <AppLayout
            cards={[{ id: "A" }, { id: "B" }, { id: "C" }]}
            onAddCard={vi.fn()}
            onRemoveCard={vi.fn()}
            activeId="A"
            onActiveIdChange={vi.fn()}
            sessionContext={{}}
            onSessionContextChange={vi.fn()}
            shellContext={{}}
            onShellContextChange={vi.fn()}
          />
        </React.StrictMode>,
      );
    });

    // Wait for all listen() calls to settle — at least two per terminal
    // (pty:output + pty:exit), times 3 terminals.
    const mockListen = listen as unknown as AnyMock;
    await vi.waitFor(() => {
      expect((mockListen.mock.calls as unknown[]).length).toBeGreaterThanOrEqual(6);
    });

    // Drain microtasks so any in-flight spawns and error callbacks settle.
    await act(async () => {
      await Promise.resolve();
    });

    // Iterate every xterm instance created across the render.
    const MockXTerm = XTerm as unknown as AnyMock;
    const allWritelnCalls: unknown[][] = [];
    for (const result of MockXTerm.mock.results as Array<{ value: { writeln: AnyMock } }>) {
      if (result.value?.writeln?.mock?.calls) {
        allWritelnCalls.push(...(result.value.writeln.mock.calls as unknown[][]));
      }
    }
    for (const [arg] of allWritelnCalls) {
      expect(String(arg)).not.toContain("[failed to start shell");
      expect(String(arg)).not.toContain("[pty write failed");
    }
  });

  it("rapid card-add does not produce duplicate-spawn errors at the backend boundary", async () => {
    const mockInvoke = invoke as unknown as AnyMock;
    installSessionAwareMock(mockInvoke);

    // Render with one card first.
    const { rerender } = renderWithProviders(
      <AppLayout
        cards={[{ id: "card-1" }]}
        onAddCard={vi.fn()}
        onRemoveCard={vi.fn()}
        activeId="card-1"
        onActiveIdChange={vi.fn()}
        sessionContext={{}}
        onSessionContextChange={vi.fn()}
        shellContext={{}}
        onShellContextChange={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Add three more cards in quick succession (mimicking + button spam).
    await act(async () => {
      rerender(
        <AppLayout
          cards={[{ id: "card-1" }, { id: "card-2" }, { id: "card-3" }, { id: "card-4" }]}
          onAddCard={vi.fn()}
          onRemoveCard={vi.fn()}
          activeId="card-1"
          onActiveIdChange={vi.fn()}
          sessionContext={{}}
          onSessionContextChange={vi.fn()}
          shellContext={{}}
          onShellContextChange={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await Promise.resolve();
    });

    // No pty_spawn invocation should have rejected with "session already exists".
    // Each card has a unique id so no duplicate spawns should occur.
    const spawnCalls = (mockInvoke.mock.calls as [string, unknown][]).filter(
      (c) => c[0] === "pty_spawn",
    );
    // There should be at least one spawn per unique card.
    expect(spawnCalls.length).toBeGreaterThanOrEqual(4);

    // Check no invoke returned a rejection for "session already exists".
    // The session-aware mock throws; if the spawn-chain is correct those throws
    // won't occur because each card has a distinct id.
    const allResults = mockInvoke.mock.results as Array<{
      type: string;
      value: unknown;
    }>;
    const settledResults = await Promise.all(
      allResults
        .filter((r) => r.type === "return" && r.value instanceof Promise)
        .map((r) => (r.value as Promise<unknown>).catch((e: unknown) => e)),
    );
    for (const val of settledResults) {
      if (val instanceof Error) {
        expect(val.message).not.toContain("session already exists");
      }
    }
  });
});

// ── Keyboard navigation integration tests ─────────────────────────────────────

describe("AppLayout — keyboard navigation", () => {
  const threeCards = [{ id: "A" }, { id: "B" }, { id: "C" }];

  function renderLayout(cards: { id: string }[], activeId: string | null) {
    const onActiveIdChange = vi.fn();
    const user = userEvent.setup();
    const result = renderWithProviders(
      <AppLayout
        cards={cards}
        onAddCard={vi.fn()}
        onRemoveCard={vi.fn()}
        activeId={activeId}
        onActiveIdChange={onActiveIdChange}
        sessionContext={{}}
        onSessionContextChange={vi.fn()}
        shellContext={{}}
        onShellContextChange={vi.fn()}
      />,
    );
    return { ...result, onActiveIdChange, user };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    _clearSpawnChainForTesting();
    (invoke as unknown as AnyMock).mockResolvedValue(1);
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }) as unknown as typeof ResizeObserver;
  });

  it("cycle next (mod+ArrowRight) from middle card activates next card", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "B");
    await act(async () => {
      await user.keyboard("{Meta>}{ArrowRight}{/Meta}");
    });
    expect(onActiveIdChange).toHaveBeenCalledTimes(1);
    expect(onActiveIdChange).toHaveBeenCalledWith("C");
  });

  it("cycle previous (mod+ArrowLeft) from middle card activates previous card", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "B");
    await act(async () => {
      await user.keyboard("{Meta>}{ArrowLeft}{/Meta}");
    });
    expect(onActiveIdChange).toHaveBeenCalledTimes(1);
    expect(onActiveIdChange).toHaveBeenCalledWith("A");
  });

  it("cycle next wraps from last card to first card", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "C");
    await act(async () => {
      await user.keyboard("{Meta>}{ArrowRight}{/Meta}");
    });
    expect(onActiveIdChange).toHaveBeenCalledTimes(1);
    expect(onActiveIdChange).toHaveBeenCalledWith("A");
  });

  it("cycle previous wraps from first card to last card", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "A");
    await act(async () => {
      await user.keyboard("{Meta>}{ArrowLeft}{/Meta}");
    });
    expect(onActiveIdChange).toHaveBeenCalledTimes(1);
    expect(onActiveIdChange).toHaveBeenCalledWith("C");
  });

  it("numeric jump mod+1 activates first card", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "B");
    await act(async () => {
      await user.keyboard("{Meta>}1{/Meta}");
    });
    expect(onActiveIdChange).toHaveBeenCalledTimes(1);
    expect(onActiveIdChange).toHaveBeenCalledWith("A");
  });

  it("numeric jump mod+3 activates third card", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "A");
    await act(async () => {
      await user.keyboard("{Meta>}3{/Meta}");
    });
    expect(onActiveIdChange).toHaveBeenCalledTimes(1);
    expect(onActiveIdChange).toHaveBeenCalledWith("C");
  });

  it("numeric jump beyond range is a no-op", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "A");
    await act(async () => {
      await user.keyboard("{Meta>}4{/Meta}");
    });
    expect(onActiveIdChange).not.toHaveBeenCalled();
  });

  it("cycle is a no-op with one card", async () => {
    const { onActiveIdChange, user } = renderLayout([{ id: "A" }], "A");
    await act(async () => {
      await user.keyboard("{Meta>}{ArrowRight}{/Meta}");
    });
    expect(onActiveIdChange).not.toHaveBeenCalled();
  });

  it("cycle is a no-op with zero cards", async () => {
    const { onActiveIdChange, user } = renderLayout([], null);
    await act(async () => {
      await user.keyboard("{Meta>}{ArrowRight}{/Meta}");
    });
    expect(onActiveIdChange).not.toHaveBeenCalled();
  });

  it("mod+0 is unhandled (regression guard)", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "A");
    await act(async () => {
      await user.keyboard("{Meta>}0{/Meta}");
    });
    expect(onActiveIdChange).not.toHaveBeenCalled();
  });

  it("hotkey fires while a textarea is focused (tagsToIgnore: [] override)", async () => {
    const { onActiveIdChange, user } = renderLayout(threeCards, "B");

    const textarea = document.createElement("textarea");
    textarea.setAttribute("data-testid", "probe-textarea");
    document.body.appendChild(textarea);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    try {
      await act(async () => {
        await user.keyboard("{Meta>}{ArrowRight}{/Meta}");
      });
      expect(onActiveIdChange).toHaveBeenCalledTimes(1);
      expect(onActiveIdChange).toHaveBeenCalledWith("C");
    } finally {
      document.body.removeChild(textarea);
    }
  });
});

// ── Shortcut tooltip overlay integration tests ─────────────────────────────────

describe("AppLayout — shortcut tooltip overlay", () => {
  // Use real timers — the existing test infrastructure (vi.mock chain, installSessionAwareMock,
  // _clearSpawnChainForTesting, vi.waitFor) does not mix safely with vi.useFakeTimers().
  // The 250 ms hold delay is exercised via real wall-clock time in vi.waitFor polling.

  beforeEach(() => {
    vi.clearAllMocks();
    _clearSpawnChainForTesting();
    (invoke as unknown as AnyMock).mockResolvedValue(1);
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }) as unknown as typeof ResizeObserver;

    // Stub macOS so isMacPlatform() returns true → ⌘ glyph
    Object.defineProperty(navigator, "userAgentData", {
      value: { platform: "macOS" },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "userAgentData", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  it("holding Meta for 250ms shows ⌘1/⌘2/⌘3 on 3 cards; releasing hides them", async () => {
    const user = userEvent.setup({ delay: null });

    renderWithProviders(
      <AppLayout
        cards={[{ id: "A" }, { id: "B" }, { id: "C" }]}
        onAddCard={vi.fn()}
        onRemoveCard={vi.fn()}
        activeId="A"
        onActiveIdChange={vi.fn()}
        sessionContext={{}}
        onSessionContextChange={vi.fn()}
        shellContext={{}}
        onShellContextChange={vi.fn()}
      />,
    );

    // No tooltip initially
    expect(screen.queryByText("⌘1")).toBeNull();

    // Hold Meta key open (no release)
    await user.keyboard("{Meta>}");

    // Wait for the 250 ms hold-delay timer to fire; poll with a generous timeout
    await vi.waitFor(() => expect(screen.getByText("⌘1")).toBeInTheDocument(), {
      timeout: 500,
    });
    expect(screen.getByText("⌘2")).toBeInTheDocument();
    expect(screen.getByText("⌘3")).toBeInTheDocument();

    // Release Meta
    await user.keyboard("{/Meta}");

    // Tooltips should disappear
    await vi.waitFor(() => expect(screen.queryByText("⌘1")).toBeNull());
  });
});

// ── Settings gear button + modal integration tests ─────────────────────────────

describe("AppLayout — settings gear button and modal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearSpawnChainForTesting();
    (invoke as unknown as AnyMock).mockResolvedValue(1);
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }) as unknown as typeof ResizeObserver;
  });

  function renderLayout() {
    return renderWithProviders(
      <AppLayout
        cards={[]}
        onAddCard={vi.fn()}
        onRemoveCard={vi.fn()}
        activeId={null}
        onActiveIdChange={vi.fn()}
        sessionContext={{}}
        onSessionContextChange={vi.fn()}
        shellContext={{}}
        onShellContextChange={vi.fn()}
      />,
    );
  }

  it("gear button is present in the header", () => {
    renderLayout();
    expect(screen.getByRole("button", { name: /open settings/i })).toBeInTheDocument();
  });

  it("clicking the gear button opens the Settings modal", async () => {
    const user = userEvent.setup();
    renderLayout();

    // Modal should not be open initially
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /open settings/i }));
    });

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
  });

  it("Settings modal closes on close-button click", async () => {
    const user = userEvent.setup();
    renderLayout();

    // Open modal
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /open settings/i }));
    });
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();

    // Click the modal's close button. Mantine renders it inside the dialog section.
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const closeButton = within(dialog).getByRole("button");
    await act(async () => {
      await user.click(closeButton);
    });

    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    });
  });
});
