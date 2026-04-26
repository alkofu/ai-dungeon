import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { renderWithProviders } from "./test-utils/render";
import { App, appReducer } from "./App";
import type { AppState, SessionContext } from "./App";
import { invoke } from "@tauri-apps/api/core";

// Capture the latest onContextChange prop passed to the Terminal mock so
// integration tests can fire OSC context changes through the full plumbing.
let capturedOnContextChange: ((ctx: SessionContext) => void) | undefined;

vi.mock("./components/Terminal/Terminal", () => ({
  Terminal: vi.fn(
    (props: { sessionId?: string; onContextChange?: (ctx: SessionContext) => void }) => {
      capturedOnContextChange = props.onContextChange;
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

type AnyMock = ReturnType<typeof vi.fn>;

// Integration note: the OSC 7 / OSC 7337 → SessionCard row-2 propagation chain is
// covered by appReducer unit tests (below) and SessionCard.test.tsx tests 12-15.
// No component-level integration test is added here because the xterm OSC handlers
// never fire in jsdom (xterm is fully mocked), making a component-level test of the
// full chain impractical without significant test-infrastructure investment.
describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnContextChange = undefined;
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
    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(screen.getByTestId("terminal-root")).toBeInTheDocument();
    // Empty state disappears once a card exists.
    expect(screen.queryByTestId("main-empty-state")).toBeNull();
  });

  it("adds and removes a card via the navbar", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

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
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await user.click(screen.getByRole("button", { name: "Add card" }));

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
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await user.click(screen.getByRole("button", { name: "Add card" }));

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
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await user.click(screen.getByRole("button", { name: "Add card" }));

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
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await user.click(screen.getByRole("button", { name: "Add card" }));

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
    await user.click(screen.getByRole("button", { name: "Add card" }));

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

  it("SessionCard row-2 updates when the Terminal's onContextChange callback fires", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

    // Fire the onContextChange callback captured from the Terminal mock.
    await act(async () => {
      capturedOnContextChange?.({
        cwd: "/home/user/project/backend-service",
        git: { repo: "backend-service", branch: "main" },
      });
    });

    // SessionCard row-2 should now show the repo name and branch.
    expect(screen.getByText("backend-service")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
  });
});

describe("appReducer", () => {
  it("activate ignores null while cards exist", () => {
    const card = { id: "test-uuid-1" };
    const state: AppState = { cards: [card], activeId: "test-uuid-1", contexts: {} };
    expect(appReducer(state, { type: "activate", id: null })).toBe(state); // referential equality
  });

  it("activate accepts null when no cards exist", () => {
    const state: AppState = { cards: [], activeId: null, contexts: {} };
    const result = appReducer(state, { type: "activate", id: null });
    expect(result).toEqual({ cards: [], activeId: null, contexts: {} });
  });

  it("add seeds an empty context for the new card", () => {
    const state: AppState = { cards: [], activeId: null, contexts: {} };
    const result = appReducer(state, { type: "add" });
    const newId = result.cards[0]!.id;
    expect(result.contexts[newId]).toEqual({ cwd: null, git: null });
  });

  it("remove deletes the context entry for the removed card", () => {
    const cardId = "test-uuid-1";
    const state: AppState = {
      cards: [{ id: cardId }],
      activeId: cardId,
      contexts: { [cardId]: { cwd: "/home/user", git: null } },
    };
    const result = appReducer(state, { type: "remove", id: cardId });
    expect(result.contexts[cardId]).toBeUndefined();
  });

  it("setContext merges the ctx into the matching session", () => {
    const cardId = "test-uuid-1";
    const otherId = "test-uuid-2";
    const state: AppState = {
      cards: [{ id: cardId }, { id: otherId }],
      activeId: cardId,
      contexts: {
        [cardId]: { cwd: null, git: null },
        [otherId]: { cwd: "/other", git: null },
      },
    };
    const newCtx = { cwd: "/foo", git: { repo: "my-repo", branch: "main" } };
    const result = appReducer(state, { type: "setContext", id: cardId, ctx: newCtx });
    expect(result.contexts[cardId]).toEqual(newCtx);
    // Other sessions unaffected.
    expect(result.contexts[otherId]).toEqual({ cwd: "/other", git: null });
  });

  it("setContext for a removed id is a no-op (returns same state reference)", () => {
    const cardId = "test-uuid-1";
    const removedId = "test-uuid-removed";
    const state: AppState = {
      cards: [{ id: cardId }],
      activeId: cardId,
      contexts: { [cardId]: { cwd: null, git: null } },
    };
    const result = appReducer(state, {
      type: "setContext",
      id: removedId,
      ctx: { cwd: "/foo", git: null },
    });
    expect(result).toBe(state); // referential equality — no-op
  });
});
