import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { renderWithProviders } from "./test-utils/render";
import { App, appReducer } from "./App";
import type { AppState } from "./App";
import type { SessionContext, ShellContext } from "./types/session";
import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "./components/Terminal/Terminal";

// Capture the latest callbacks passed to the Terminal mock so
// integration tests can fire OSC context changes through the full plumbing.
let capturedOnSessionContextChange: ((ctx: SessionContext) => void) | undefined;
let capturedOnShellContextChange: ((ctx: ShellContext) => void) | undefined;
// Captures the most recently mounted Terminal's onReady callback (tests 1, 2, 4).
let capturedOnReady: (() => void) | undefined;
// Map-keyed-by-sessionId capture for the per-card independence test (test 3).
const capturedOnReadyByCard = new Map<string, () => void>();

// Mock the lazy re-export (index.ts) with an eager pass-through so React.lazy
// resolves synchronously in tests. The concrete Terminal module mock below
// provides the actual implementation; this mock simply bypasses the lazy wrapper.
vi.mock("./components/Terminal", async () => {
  const mod = await import("./components/Terminal/Terminal");
  return { Terminal: mod.Terminal };
});

vi.mock("./components/Terminal/Terminal", () => ({
  Terminal: vi.fn(
    (props: {
      sessionId?: string;
      onSessionContextChange?: (ctx: SessionContext) => void;
      onShellContextChange?: (ctx: ShellContext) => void;
      onReady?: () => void;
    }) => {
      capturedOnSessionContextChange = props.onSessionContextChange;
      capturedOnShellContextChange = props.onShellContextChange;
      capturedOnReady = props.onReady;
      if (props.sessionId !== undefined && props.onReady !== undefined) {
        capturedOnReadyByCard.set(props.sessionId, props.onReady);
      }
      // Render the sentinel div so existing tests that query terminal-root continue to work.
      return <div data-testid="terminal-root" />;
    },
  ),
}));

// Mock xterm to avoid jsdom canvas/layout API issues
vi.mock("@xterm/xterm", () => {
  return {
    Terminal: vi.fn().mockImplementation(function () {
      return {
        write: vi.fn(),
        writeln: vi.fn(),
        open: vi.fn(),
        loadAddon: vi.fn(),
        dispose: vi.fn(),
        onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        parser: { registerOscHandler: vi.fn().mockReturnValue({ dispose: vi.fn() }) },
      };
    }),
  };
});

vi.mock("@xterm/addon-fit", () => {
  return {
    FitAddon: vi.fn().mockImplementation(function () {
      return {
        fit: vi.fn(),
        proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      };
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation(() => Promise.resolve(vi.fn())),
}));

// Mock SettingsContext so AppLayout's SettingsModal can call useSettings()
// without a real provider or Tauri fs plugin.
vi.mock("./settings/SettingsContext", () => ({
  useSettings: () => ({
    settings: {
      version: 1,
      colorScheme: "auto",
      terminal: { fontSize: 13 },
    },
    updateSettings: vi.fn().mockResolvedValue(undefined),
    saveError: null,
  }),
}));

type AnyMock = ReturnType<typeof vi.fn>;

// Integration note: the OSC 6800 → SessionCard row-2 propagation chain is
// covered by appReducer unit tests (below) and SessionCard.test.tsx tests.
// No component-level integration test is added here because the xterm OSC handlers
// never fire in jsdom (xterm is fully mocked), making a component-level test of the
// full chain impractical without significant test-infrastructure investment.
describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSessionContextChange = undefined;
    capturedOnShellContextChange = undefined;
    capturedOnReady = undefined;
    capturedOnReadyByCard.clear();
    (invoke as unknown as AnyMock).mockResolvedValue(undefined);

    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }) as unknown as typeof ResizeObserver;
  });

  it("renders the empty-state message when there are no cards, then shows a terminal after adding one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Initial state: no cards — empty state visible, no terminal.
    expect(screen.getByTestId("main-empty-state")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-root")).toBeNull();

    // Add a card — terminal should appear.
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    expect(screen.getByTestId("terminal-root")).toBeInTheDocument();
    // Empty state disappears once a card exists.
    expect(screen.queryByTestId("main-empty-state")).toBeNull();
  });

  it("adds and removes a card via the navbar", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    const removeButton = screen.getByRole("button", { name: /Remove card/i });
    expect(removeButton).toBeInTheDocument();

    // After adding one card, exactly one terminal is mounted.
    expect(screen.queryAllByTestId("terminal-root")).toHaveLength(1);

    await user.click(removeButton);

    expect(screen.queryByRole("button", { name: /Remove card/i })).toBeNull();
    // After removing the only card, no terminals remain in the DOM.
    expect(screen.queryAllByTestId("terminal-root")).toHaveLength(0);
  });

  it("keeps all terminals in the DOM when switching tabs (keepMounted)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Add two cards.
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    // Both terminals are mounted because keepMounted=true.
    expect(screen.queryAllByTestId("terminal-root")).toHaveLength(2);

    // Click the second tab (the second card's tab).
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);

    // The first tab was activated on first add (first add rule). Click the second.
    await user.click(tabs[1]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");

    // Both terminals still in DOM after tab switch (keepMounted proof).
    expect(screen.queryAllByTestId("terminal-root")).toHaveLength(2);

    // Switch back to the first tab.
    await user.click(tabs[0]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    // Still both mounted.
    expect(screen.queryAllByTestId("terminal-root")).toHaveLength(2);
  });

  it("moves the active tab to the previous card when the active (last) card is removed", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Add three cards: A (active), B, C.
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);

    // Under the "first add becomes active" rule, tab[0] (A) is active.
    // Click tab[2] (C) to make it active.
    await user.click(tabs[2]);
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");

    // Remove C (the active tab) — active should move to B (previous in list).
    const removeButtons = screen.getAllByRole("button", { name: /Remove card/i });
    await user.click(removeButtons[2]);

    // Now two tabs remain; the last one (B, now at index 1) should be active.
    const remainingTabs = screen.getAllByRole("tab");
    expect(remainingTabs).toHaveLength(2);
    expect(remainingTabs[1]).toHaveAttribute("aria-selected", "true");

    // Remove B (active) — active moves to A (the only remaining card).
    const removeButtons2 = screen.getAllByRole("button", { name: /Remove card/i });
    await user.click(removeButtons2[1]);

    const finalTabs = screen.getAllByRole("tab");
    expect(finalTabs).toHaveLength(1);
    expect(finalTabs[0]).toHaveAttribute("aria-selected", "true");

    // Remove A — empty state returns.
    const lastRemoveButton = screen.getByRole("button", { name: /Remove card/i });
    await user.click(lastRemoveButton);

    expect(screen.queryAllByTestId("terminal-root")).toHaveLength(0);
    expect(screen.getByTestId("main-empty-state")).toBeInTheDocument();
  });

  it("moves active tab to previous card when a non-last active card is removed (F-3)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Add three cards A, B, C. A is active (first-add rule).
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    const tabs = screen.getAllByRole("tab");

    // Activate B (index 1).
    await user.click(tabs[1]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");

    // Remove B — active should move to A (previous, index 0 in remaining [A, C]).
    const removeButtons = screen.getAllByRole("button", { name: /Remove card/i });
    await user.click(removeButtons[1]);

    const remainingTabs = screen.getAllByRole("tab");
    expect(remainingTabs).toHaveLength(2);
    // A is at index 0 of remaining; it should now be active.
    expect(remainingTabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("does NOT call pty_kill when switching tabs (PTY sessions preserved)", async () => {
    const mockInvoke = invoke as unknown as AnyMock;
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Add two cards.
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    // Both spawns happen synchronously relative to user events. Drain the
    // microtask queue to ensure any async IIFE cancelled-path activity (which
    // could call pty_kill if a terminal unmounted during an in-flight spawn)
    // has settled before we clear the call history.
    await new Promise((r) => setTimeout(r, 0));

    // Clear call history AFTER all async setup has settled. The assertion
    // below is only about tab-switching behaviour (not spawn activity).
    mockInvoke.mockClear();

    const tabs = screen.getAllByRole("tab");

    // Switch back and forth three times.
    await user.click(tabs[1]);
    await user.click(tabs[0]);
    await user.click(tabs[1]);

    // Assert pty_kill was never called during the tab-switching phase.
    const killCalls = mockInvoke.mock.calls.filter((c: unknown[]) => c[0] === "pty_kill");
    expect(killCalls).toHaveLength(0);

    // Both terminals remain in DOM (keepMounted proof).
    expect(screen.queryAllByTestId("terminal-root")).toHaveLength(2);
  });

  it("renders the AppShell with the burger toggle button", () => {
    renderWithProviders(<App />);
    // Burger button still renders regardless of card state.
    expect(screen.getByRole("button", { name: "Toggle navigation" })).toBeInTheDocument();
  });

  it("ignores onChange(null) from Mantine Tabs while cards exist (null-guard)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Add a card so there is an active tab.
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    // The newly added card should be active.
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    // Simulate Mantine Tabs calling onChange(null) by finding the tablist and
    // firing a custom onChange event. We do this by directly invoking the
    // internal prop. Since we can't easily reach the Tabs root onChange, we
    // verify the guard indirectly: clicking the already-active tab causes
    // Mantine to call onChange(null), and the tab should remain selected.
    await user.click(tabs[0]);

    // The tab must remain selected — null must be ignored.
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });

  it("SessionCard row-2 updates when the Terminal's onSessionContextChange callback fires", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    // Fire the onSessionContextChange callback captured from the Terminal mock.
    await act(async () => {
      capturedOnSessionContextChange?.({
        sessionTs: "20260425-120000",
        slug: "backend-service",
        workingDirectory: "/home/user/project/backend-service",
        branch: "main",
        repo: { owner: "acme", name: "widgets" },
      });
    });

    // SessionCard row-2 should now show the slug.
    expect(screen.getByText("backend-service")).toBeInTheDocument();
  });

  it("adding a dungeon card from the menu mounts the placeholder, not a Terminal, and does not invoke pty_spawn", async () => {
    const mockInvoke = invoke as unknown as AnyMock;
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Open the menu and pick "Dungeon".
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Dungeon" }));

    // No terminal root rendered.
    expect(screen.queryByTestId("terminal-root")).toBeNull();
    // Dungeon placeholder is in the DOM.
    expect(screen.getByText("Dungeon: under construction")).toBeInTheDocument();
    // No pty_spawn invocation.
    const spawnCalls = mockInvoke.mock.calls.filter((c: unknown[]) => c[0] === "pty_spawn");
    expect(spawnCalls).toHaveLength(0);
    // The mocked Terminal factory was never called.
    expect(Terminal).not.toHaveBeenCalled();
  });

  it("setShellContext populates state.shellContext[id] independently of state.sessionContext[id]", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    // Fire onShellContextChange — should NOT affect sessionContext.
    await act(async () => {
      capturedOnShellContextChange?.({
        workingDirectory: "/shell/path",
        branch: "shell-branch",
      });
    });

    // No sessionContext is set, so SessionCard falls back to shellContext, which
    // produces "(shell)" as the slug placeholder. This proves that shellContext
    // is used independently of sessionContext and that state independence is maintained.
    expect(screen.getByText("(shell)")).toBeInTheDocument();
  });

  it("shows the loading overlay for a freshly-added terminal card", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    // The parent has not received onReady yet, so the overlay should be visible.
    expect(screen.getByTestId("terminal-loading-overlay")).toBeInTheDocument();
  });

  it("removes the loading overlay once Terminal fires onReady", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    // Overlay present before onReady fires.
    expect(screen.getByTestId("terminal-loading-overlay")).toBeInTheDocument();

    // Fire onReady through the captured callback.
    await act(async () => {
      capturedOnReady?.();
    });

    // Overlay should be gone; terminal-root still present.
    expect(screen.queryByTestId("terminal-loading-overlay")).toBeNull();
    expect(screen.getByTestId("terminal-root")).toBeInTheDocument();
  });

  it("removes the loading overlay independently per card", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Add first terminal card.
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    // Add second terminal card.
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    // Both overlays present initially.
    expect(screen.getAllByTestId("terminal-loading-overlay")).toHaveLength(2);

    // Retrieve the first card's sessionId from the map (first entry added).
    const [firstSessionId] = capturedOnReadyByCard.keys();
    const firstOnReady = capturedOnReadyByCard.get(firstSessionId);

    // Fire only the first card's onReady.
    await act(async () => {
      firstOnReady?.();
    });

    // Exactly one overlay should remain (the second card's).
    expect(screen.getAllByTestId("terminal-loading-overlay")).toHaveLength(1);
  });

  it("removing a terminal card clears its readyCardIds entry (no leak)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    // Add a card and fire onReady.
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    await act(async () => {
      capturedOnReady?.();
    });

    // Overlay should be gone after onReady.
    expect(screen.queryByTestId("terminal-loading-overlay")).toBeNull();

    // Remove the card.
    await user.click(screen.getByRole("button", { name: /Remove card/i }));

    // Add a new card — it should show the overlay (fresh id, not in readyCardIds).
    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    await act(async () => {
      await Promise.resolve();
    });

    // The new card's overlay must be present — proves readyCardIds doesn't leak.
    expect(screen.getByTestId("terminal-loading-overlay")).toBeInTheDocument();
  });
});

describe("appReducer", () => {
  it("activate ignores null while cards exist", () => {
    const card = { id: "test-uuid-1", type: "terminal" as const };
    const state: AppState = {
      cards: [card],
      activeId: "test-uuid-1",
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    expect(appReducer(state, { type: "activate", id: null })).toBe(state); // referential equality
  });

  it("activate accepts null when no cards exist", () => {
    const state: AppState = {
      cards: [],
      activeId: null,
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const result = appReducer(state, { type: "activate", id: null });
    expect(result).toEqual({
      cards: [],
      activeId: null,
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    });
  });

  it("setSessionContext stores ctx keyed by card id", () => {
    const card = { id: "card-1", type: "terminal" as const };
    const state: AppState = {
      cards: [card],
      activeId: "card-1",
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const ctx = {
      sessionTs: "20260425-120000",
      slug: "test",
      workingDirectory: "/tmp",
      branch: "main",
      repo: { owner: "acme", name: "widgets" },
    };
    const result = appReducer(state, { type: "setSessionContext", id: "card-1", ctx });
    expect(result.sessionContext["card-1"]).toEqual(ctx);
  });

  it("setSessionContext: overwrites existing context when same card emits OSC again", () => {
    const firstCtx: SessionContext = {
      sessionTs: "20260401-120000",
      slug: "first-slug",
      workingDirectory: "/tmp",
      branch: "main",
      repo: { owner: "acme", name: "widgets" },
    };
    const secondCtx: SessionContext = {
      sessionTs: "20260401-130000",
      slug: "second-slug",
      workingDirectory: "/tmp",
      branch: "main",
      repo: { owner: "acme", name: "widgets" },
    };
    const stateAfterFirst = appReducer(
      {
        cards: [{ id: "card-1", type: "terminal" as const }],
        activeId: null,
        sessionContext: {},
        shellContext: {},
        readyCardIds: new Set(),
      },
      { type: "setSessionContext", id: "card-1", ctx: firstCtx },
    );
    const stateAfterSecond = appReducer(stateAfterFirst, {
      type: "setSessionContext",
      id: "card-1",
      ctx: secondCtx,
    });
    expect(stateAfterSecond.sessionContext["card-1"]).toEqual(secondCtx);
    // second value fully replaces first — no field bleeding
    expect(stateAfterSecond.sessionContext["card-1"].sessionTs).toBe("20260401-130000");
  });

  it("setSessionContext is a no-op if card id is not in state.cards", () => {
    const state: AppState = {
      cards: [],
      activeId: null,
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const ctx = {
      sessionTs: "20260425-120000",
      slug: "test",
      workingDirectory: "/tmp",
      branch: "main",
      repo: { owner: "acme", name: "widgets" },
    };
    const result = appReducer(state, { type: "setSessionContext", id: "ghost-id", ctx });
    expect(result).toBe(state); // referential equality — no-op
  });

  it("remove cleans up sessionContext for the removed card", () => {
    const card = { id: "card-1", type: "terminal" as const };
    const ctx = {
      sessionTs: "20260425-120000",
      slug: "test",
      workingDirectory: "/tmp",
      branch: "main",
      repo: { owner: "acme", name: "widgets" },
    };
    const state: AppState = {
      cards: [card],
      activeId: "card-1",
      sessionContext: { "card-1": ctx },
      shellContext: {},
      readyCardIds: new Set(),
    };
    const result = appReducer(state, { type: "remove", id: "card-1" });
    expect(result.sessionContext).not.toHaveProperty("card-1");
  });

  it("setShellContext stores ShellContext keyed by card id", () => {
    const state: AppState = {
      cards: [{ id: "card-1", type: "terminal" as const }],
      activeId: "card-1",
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const ctx: ShellContext = { workingDirectory: "/home/user", branch: "main" };
    const result = appReducer(state, { type: "setShellContext", id: "card-1", ctx });
    expect(result.shellContext["card-1"]).toEqual(ctx);
  });

  it("setShellContext is a no-op if card id is not in state.cards", () => {
    const state: AppState = {
      cards: [],
      activeId: null,
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const ctx: ShellContext = { workingDirectory: "/home/user" };
    const result = appReducer(state, { type: "setShellContext", id: "ghost-id", ctx });
    expect(result).toBe(state); // referential equality — no-op
  });

  it("add with cardType='dungeon' produces one dungeon card as activeId", () => {
    const state: AppState = {
      cards: [],
      activeId: null,
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const result = appReducer(state, { type: "add", cardType: "dungeon" });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].type).toBe("dungeon");
    expect(result.activeId).toBe(result.cards[0].id);
  });

  it("add terminal then dungeon produces two cards in insertion order with dungeon active", () => {
    const s0: AppState = {
      cards: [],
      activeId: null,
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const s1 = appReducer(s0, { type: "add", cardType: "terminal" });
    const s2 = appReducer(s1, { type: "add", cardType: "dungeon" });
    expect(s2.cards).toHaveLength(2);
    expect(s2.cards[0].type).toBe("terminal");
    expect(s2.cards[1].type).toBe("dungeon");
    expect(s2.activeId).toBe(s2.cards[1].id);
  });

  it("remove dungeon card is pure — does not invoke any Tauri command", () => {
    const terminalCard = { id: "term-1", type: "terminal" as const };
    const dungeonCard = { id: "dung-1", type: "dungeon" as const };
    const state: AppState = {
      cards: [terminalCard, dungeonCard],
      activeId: "term-1",
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const result = appReducer(state, { type: "remove", id: "dung-1" });
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].id).toBe("term-1");
    // Reducer is pure — no Tauri commands should be called.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("setShellContext overwrites prior ShellContext (full replacement)", () => {
    const firstCtx: ShellContext = { workingDirectory: "/old", branch: "old-branch" };
    const secondCtx: ShellContext = { workingDirectory: "/new", branch: "new-branch" };
    const state: AppState = {
      cards: [{ id: "card-1", type: "terminal" as const }],
      activeId: "card-1",
      sessionContext: {},
      shellContext: { "card-1": firstCtx },
      readyCardIds: new Set(),
    };
    const result = appReducer(state, { type: "setShellContext", id: "card-1", ctx: secondCtx });
    expect(result.shellContext["card-1"]).toEqual(secondCtx);
    // Full replacement — no field bleeding from first.
    expect(result.shellContext["card-1"].branch).toBe("new-branch");
  });

  it("remove deletes per-card entry from shellContext", () => {
    const ctx: ShellContext = { workingDirectory: "/home/user", branch: "main" };
    const state: AppState = {
      cards: [{ id: "card-1", type: "terminal" as const }],
      activeId: "card-1",
      sessionContext: {},
      shellContext: { "card-1": ctx },
      readyCardIds: new Set(),
    };
    const result = appReducer(state, { type: "remove", id: "card-1" });
    expect(result.shellContext).not.toHaveProperty("card-1");
  });

  it("add does not flip readyCardIds for the new card", () => {
    const state: AppState = {
      cards: [],
      activeId: null,
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const result = appReducer(state, { type: "add", cardType: "terminal" });
    expect(result.readyCardIds.size).toBe(0);
  });

  it("markReady adds the id to readyCardIds", () => {
    const card = { id: "card-1", type: "terminal" as const };
    const state: AppState = {
      cards: [card],
      activeId: "card-1",
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(),
    };
    const result = appReducer(state, { type: "markReady", id: "card-1" });
    expect(result.readyCardIds.has("card-1")).toBe(true);
  });

  it("markReady is idempotent (returns same state when id already present)", () => {
    const state: AppState = {
      cards: [{ id: "X", type: "terminal" as const }],
      activeId: "X",
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(["X"]),
    };
    const result = appReducer(state, { type: "markReady", id: "X" });
    expect(result).toBe(state); // referential equality
  });

  it("remove clears readyCardIds entry for the removed card", () => {
    const state: AppState = {
      cards: [{ id: "X", type: "terminal" as const }],
      activeId: "X",
      sessionContext: {},
      shellContext: {},
      readyCardIds: new Set(["X"]),
    };
    const result = appReducer(state, { type: "remove", id: "X" });
    expect(result.readyCardIds.has("X")).toBe(false);
  });
});
