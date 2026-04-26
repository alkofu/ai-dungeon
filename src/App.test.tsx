import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "@testing-library/react";
import { renderWithProviders } from "./test-utils/render";
import { App, appReducer } from "./App";
import type { AppState } from "./App";
import type { SessionContext } from "./types/session";
import { invoke } from "@tauri-apps/api/core";

// Capture the latest callbacks passed to the Terminal mock so
// integration tests can fire OSC context changes through the full plumbing.
let capturedOnSessionContextChange: ((ctx: SessionContext) => void) | undefined;
let capturedOnSessionContextPatch: ((patch: Partial<SessionContext>) => void) | undefined;

vi.mock("./components/Terminal/Terminal", () => ({
  Terminal: vi.fn(
    (props: {
      sessionId?: string;
      onSessionContextChange?: (ctx: SessionContext) => void;
      onSessionContextPatch?: (patch: Partial<SessionContext>) => void;
    }) => {
      capturedOnSessionContextChange = props.onSessionContextChange;
      capturedOnSessionContextPatch = props.onSessionContextPatch;
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

// Integration note: the OSC 6800 → SessionCard row-2 propagation chain is
// covered by appReducer unit tests (below) and SessionCard.test.tsx tests.
// No component-level integration test is added here because the xterm OSC handlers
// never fire in jsdom (xterm is fully mocked), making a component-level test of the
// full chain impractical without significant test-infrastructure investment.
describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnSessionContextChange = undefined;
    capturedOnSessionContextPatch = undefined;
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

  it("SessionCard row-2 updates when the Terminal's onSessionContextChange callback fires", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

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

  it("SessionCard row-2 updates incrementally when onSessionContextPatch fires after a full-context initialisation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

    // Initialise with a full SessionContext.
    await act(async () => {
      capturedOnSessionContextChange?.({
        sessionTs: "20260425-120000",
        slug: "incremental-test",
        workingDirectory: "/initial/path",
        branch: "initial-branch",
        repo: { owner: "acme", name: "widgets" },
      });
    });

    // Confirm initial render: the last two segments of "/initial/path" is "initial/path".
    expect(screen.getByText("initial/path")).toBeInTheDocument();

    // Patch the working directory only.
    await act(async () => {
      capturedOnSessionContextPatch?.({ workingDirectory: "/updated/deep/path" });
    });

    // The tail should now show "deep/path".
    expect(screen.getByText("deep/path")).toBeInTheDocument();
    // branch must still be present (merge, not replace).
    expect(screen.getByText("initial-branch")).toBeInTheDocument();
  });

  it("OSC 6800 → OSC 7 → OSC 6800 fully replaces the patched record", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

    // First full OSC 6800.
    await act(async () => {
      capturedOnSessionContextChange?.({
        sessionTs: "20260425-120000",
        slug: "replace-test",
        workingDirectory: "/a",
        branch: "a-branch",
        repo: { owner: "acme", name: "widgets" },
      });
    });

    // Patch working directory via OSC 7.
    await act(async () => {
      capturedOnSessionContextPatch?.({ workingDirectory: "/patched" });
    });
    expect(screen.getByText("patched")).toBeInTheDocument();
    expect(screen.getByText("a-branch")).toBeInTheDocument();

    // Second full OSC 6800 with completely different context.
    await act(async () => {
      capturedOnSessionContextChange?.({
        sessionTs: "20260425-130000",
        slug: "replace-test",
        workingDirectory: "/b",
        branch: "b-branch",
        repo: { owner: "acme", name: "widgets" },
      });
    });

    // Full replacement: working directory tail should be "b", branch "b-branch".
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("b-branch")).toBeInTheDocument();
    // "a-branch" must be gone.
    expect(screen.queryByText("a-branch")).toBeNull();
  });

  it("SessionCard renders without crashing after empty OSC 7337 clears branch and repo", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

    const meta: SessionContext = {
      sessionTs: "20260425-120000",
      slug: "smoke",
      workingDirectory: "/some/path",
      branch: "main",
      repo: { owner: "acme", name: "widgets" },
    };

    // Defensive pre-condition: slug visible before the patch.
    await act(async () => {
      capturedOnSessionContextChange?.(meta);
    });
    expect(screen.getByText(meta.slug)).toBeInTheDocument();
    expect(screen.getByText("widgets")).toBeInTheDocument();

    // Clear branch and repo via empty OSC 7337.
    await act(async () => {
      capturedOnSessionContextPatch?.({ branch: undefined, repo: undefined });
    });

    // Crash-free assertions.
    expect(screen.getByText(meta.slug)).toBeInTheDocument();
    expect(screen.queryByText("acme/widgets")).toBeNull();
    expect(screen.queryByText("widgets")).toBeNull();
    // Re-assert slug is still in the DOM.
    expect(screen.getByText(meta.slug)).toBeInTheDocument();
  });
});

describe("appReducer", () => {
  it("activate ignores null while cards exist", () => {
    const card = { id: "test-uuid-1" };
    const state: AppState = { cards: [card], activeId: "test-uuid-1", sessionContext: {} };
    expect(appReducer(state, { type: "activate", id: null })).toBe(state); // referential equality
  });

  it("activate accepts null when no cards exist", () => {
    const state: AppState = { cards: [], activeId: null, sessionContext: {} };
    const result = appReducer(state, { type: "activate", id: null });
    expect(result).toEqual({ cards: [], activeId: null, sessionContext: {} });
  });

  it("setSessionContext stores ctx keyed by card id", () => {
    const card = { id: "card-1" };
    const state: AppState = { cards: [card], activeId: "card-1", sessionContext: {} };
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
      { cards: [{ id: "card-1" }], activeId: null, sessionContext: {} },
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
    const state: AppState = { cards: [], activeId: null, sessionContext: {} };
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
    const card = { id: "card-1" };
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
    };
    const result = appReducer(state, { type: "remove", id: "card-1" });
    expect(result.sessionContext).not.toHaveProperty("card-1");
  });

  it("patchSessionContext merges patch into existing record", () => {
    const fullCtx: SessionContext = {
      sessionTs: "20260425-120000",
      slug: "test",
      workingDirectory: "/old",
      branch: "main",
      repo: { owner: "acme", name: "widgets" },
    };
    const state: AppState = {
      cards: [{ id: "card-1" }],
      activeId: "card-1",
      sessionContext: { "card-1": fullCtx },
    };
    const result = appReducer(state, {
      type: "patchSessionContext",
      id: "card-1",
      patch: { workingDirectory: "/new" },
    });
    expect(result.sessionContext["card-1"].workingDirectory).toBe("/new");
    // All other fields unchanged.
    expect(result.sessionContext["card-1"].slug).toBe("test");
    expect(result.sessionContext["card-1"].branch).toBe("main");
    expect(result.sessionContext["card-1"].repo).toEqual({ owner: "acme", name: "widgets" });
  });

  it("patchSessionContext is a no-op if no record exists for the card id", () => {
    // DEV-env precondition: the no-op DEV branch uses import.meta.env.DEV.
    expect(import.meta.env.DEV).toBe(true);

    const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const state: AppState = {
      cards: [{ id: "card-1" }],
      activeId: "card-1",
      sessionContext: {},
    };
    const result = appReducer(state, {
      type: "patchSessionContext",
      id: "card-1",
      patch: { workingDirectory: "/new" },
    });
    expect(result).toBe(state); // referential equality — no-op

    // DEV-only console.debug must have been called with the expected prefix.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[osc-7|7337]"),
      expect.anything(),
    );

    consoleSpy.mockRestore();
  });

  it("patchSessionContext is a no-op if the card id is not in state.cards", () => {
    const state: AppState = { cards: [], activeId: null, sessionContext: {} };
    const result = appReducer(state, {
      type: "patchSessionContext",
      id: "ghost-id",
      patch: { workingDirectory: "/new" },
    });
    expect(result).toBe(state); // referential equality — no-op
  });

  it("patchSessionContext does not mutate the original record", () => {
    const originalCtx: SessionContext = {
      sessionTs: "20260425-120000",
      slug: "test",
      workingDirectory: "/old",
      branch: "main",
      repo: { owner: "acme", name: "widgets" },
    };
    const state: AppState = {
      cards: [{ id: "card-1" }],
      activeId: "card-1",
      sessionContext: { "card-1": originalCtx },
    };
    const result = appReducer(state, {
      type: "patchSessionContext",
      id: "card-1",
      patch: { workingDirectory: "/new" },
    });
    // The new record must be a different object reference.
    expect(result.sessionContext["card-1"]).not.toBe(originalCtx);
    // The original must be unmodified.
    expect(originalCtx.workingDirectory).toBe("/old");
  });
});
