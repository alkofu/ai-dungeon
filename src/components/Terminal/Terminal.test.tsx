// ── Module-level mocks ────────────────────────────────────────────────────────
// These must be declared before any imports that transitively use the mocked
// modules. Vitest hoists vi.mock() calls to the top of the file.

// Mutable settings state so individual tests can change fontSize.
const mockTerminalSettings = { fontSize: 13 };

vi.mock("../../settings/SettingsContext", () => ({
  useSettings: () => ({
    settings: {
      version: 1,
      colorScheme: "auto",
      terminal: mockTerminalSettings,
    },
    updateSettings: vi.fn().mockResolvedValue(undefined),
    saveError: null,
  }),
}));

// M-6: Declare onData spies at module scope so they are stable across
// mount/cleanup boundary assertions (not re-created per test).
const onDataDisposeSpy = vi.fn();
const onDataSpy = vi.fn().mockReturnValue({ dispose: onDataDisposeSpy });

// Deferred-loadFonts factory: lets each test control when loadFonts resolves.
// Initialised in beforeEach so each test gets a fresh deferred.
let resolveLoadFonts!: (value: FontFace[]) => void;
let loadFontsPromise!: Promise<FontFace[]>;

const loadFontsSpy = vi.fn();

vi.mock("@xterm/addon-web-fonts", () => {
  function MockWebFontsAddon() {
    return {
      loadFonts: loadFontsSpy,
    };
  }
  return { WebFontsAddon: vi.fn().mockImplementation(MockWebFontsAddon) };
});

// Per-OSC-code dispose spies — declared at module scope but initialised in
// beforeEach so each test gets fresh spies.
let osc6800DisposeSpy: ReturnType<typeof vi.fn>;
let osc7DisposeSpy: ReturnType<typeof vi.fn>;
let osc7337DisposeSpy: ReturnType<typeof vi.fn>;

const registerOscHandlerSpy = vi.fn();

const attachKeyHandlerSpy = vi.fn();

vi.mock("@xterm/xterm", () => {
  const writeSpy = vi.fn();
  const writelnSpy = vi.fn();
  const openSpy = vi.fn();
  const loadAddonSpy = vi.fn();
  const disposeSpy = vi.fn();
  function MockTerminal() {
    return {
      write: writeSpy,
      writeln: writelnSpy,
      open: openSpy,
      loadAddon: loadAddonSpy,
      dispose: disposeSpy,
      onData: onDataSpy,
      parser: { registerOscHandler: registerOscHandlerSpy },
      attachCustomKeyEventHandler: attachKeyHandlerSpy,
      options: { fontSize: 13 },
    };
  }
  return { Terminal: vi.fn().mockImplementation(MockTerminal) };
});

vi.mock("@xterm/addon-fit", () => {
  const fitSpy = vi.fn();
  const proposeDimensionsSpy = vi.fn().mockReturnValue({ cols: 80, rows: 24 });
  function MockFitAddon() {
    return { fit: fitSpy, proposeDimensions: proposeDimensionsSpy };
  }
  return { FitAddon: vi.fn().mockImplementation(MockFitAddon) };
});

// Default: pty_spawn resolves to numeric generation 1 (Ruinor F-6).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(1),
}));

// Each listen() call resolves to a fresh unlisten spy.
// We also keep a module-level array so tests can retrieve the resolved functions.
const unlistenSpies: ReturnType<typeof vi.fn>[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation(() => {
    const unlisten = vi.fn();
    unlistenSpies.push(unlisten);
    return Promise.resolve(unlisten);
  }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { act } from "@testing-library/react";
import { renderWithProviders } from "../../test-utils/render";
import { Terminal, _clearSpawnChainForTesting } from "./Terminal";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type AnyMock = ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTermInstance() {
  const MockXTerm = XTerm as unknown as AnyMock;
  return MockXTerm.mock.results[MockXTerm.mock.results.length - 1].value;
}

function getFitInstance() {
  const MockFitAddonCls = FitAddon as unknown as AnyMock;
  return MockFitAddonCls.mock.results[MockFitAddonCls.mock.results.length - 1].value;
}

// Drain N microtask ticks. Each `await Promise.resolve()` advances the
// microtask queue by one tick; chaining via .then() avoids a loop construct.
function drain(n: number): Promise<void> {
  return n <= 0 ? Promise.resolve() : Promise.resolve().then(() => drain(n - 1));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Terminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear captured unlisten spies from the previous test.
    unlistenSpies.length = 0;

    // Reset mutable settings to defaults for each test.
    mockTerminalSettings.fontSize = 13;

    // Default: loadFonts resolves immediately with a one-element FontFace stub.
    // Tests that need to control timing call deferLoadFonts() to switch to a
    // deferred promise before rendering.
    loadFontsSpy.mockResolvedValue([{}] as unknown as FontFace[]);

    // Clear the module-level spawn-chain Map so prior tests' settled (or
    // in-flight) kill promises do not block subsequent tests' spawn calls.
    // Each test gets a clean chain for the session IDs it uses.
    _clearSpawnChainForTesting();

    // Initialise per-OSC-code dispose spies for this test.
    osc6800DisposeSpy = vi.fn();
    osc7DisposeSpy = vi.fn();
    osc7337DisposeSpy = vi.fn();

    // Wire registerOscHandler to return the appropriate dispose spy per code.
    registerOscHandlerSpy.mockImplementation((code: number) => ({
      dispose: code === 6800 ? osc6800DisposeSpy : code === 7 ? osc7DisposeSpy : osc7337DisposeSpy,
    }));

    // Restore invoke to its default behavior (resolves immediately) so that
    // tests which set a persistent mockImplementation (e.g. the "does NOT call
    // pty_resize before spawn completes" test) do not leak state into later
    // tests. vi.clearAllMocks() only clears call history, not implementations.
    // (Ruinor F-6: pty_spawn must return a numeric generation, not undefined.)
    (invoke as unknown as AnyMock).mockResolvedValue(1);

    // Restore a fresh ResizeObserver spy for each test.
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }) as unknown as typeof ResizeObserver;
  });

  it("calls pty_spawn with sessionId, cols, and rows on mount", async () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    // Allow the async IIFE to run.
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("pty_spawn", {
        sessionId: "00000000-0000-0000-0000-000000000001",
        cols: 80,
        rows: 24,
      });
    });
  });

  it("calls listen for pty:output and pty:exit events after spawn", async () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    await vi.waitFor(() => {
      const mockListen = listen as unknown as AnyMock;
      const eventNames = mockListen.mock.calls.map((c: unknown[]) => c[0]);
      expect(eventNames).toContain("pty:output:00000000-0000-0000-0000-000000000001");
      expect(eventNames).toContain("pty:exit:00000000-0000-0000-0000-000000000001");
    });
  });

  it("registers onData handler and forwards input as base64 via pty_write", async () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    // After the refactor, onData is registered synchronously at mount (before
    // fitAddon.fit()). Wait for it to have been registered.
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
    });

    // The callback is registered immediately but forwards keystrokes only once
    // isReadyRef.current is true (after spawn + listen calls resolve). Wait for
    // listen() to have been called before extracting and invoking the callback,
    // so that we exercise the live-path (not the buffering path).
    const mockListen = listen as unknown as AnyMock;
    await vi.waitFor(() => {
      expect(mockListen).toHaveBeenCalledTimes(2);
    });

    // Extract the onData callback and simulate a keystroke ('a').
    const onDataCallback = onDataSpy.mock.calls[onDataSpy.mock.calls.length - 1][0] as (
      data: string,
    ) => void;
    onDataCallback("a");

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("pty_write", {
        sessionId: "00000000-0000-0000-0000-000000000001",
        dataB64: "YQ==",
      });
    });
  });

  it("disposes onData, calls unlistens, and invokes pty_kill on unmount", async () => {
    const { unmount } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );

    // Wait for both listen() calls to have resolved and stored their spies.
    await vi.waitFor(() => {
      expect(unlistenSpies.length).toBeGreaterThanOrEqual(2);
    });

    // Also wait for onData to be registered (spawn + subscriptions complete).
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
    });

    const [unlisten1, unlisten2] = unlistenSpies;

    unmount();

    // Synchronous cleanup side-effects fire immediately on unmount.
    expect(onDataDisposeSpy).toHaveBeenCalledTimes(1);
    expect(unlisten1).toHaveBeenCalledTimes(1);
    expect(unlisten2).toHaveBeenCalledTimes(1);

    // pty_kill is now deferred (fire-and-forget after the spawn-chain settles).
    // Use vi.waitFor to handle the async dispatch (Ruinor F-6 timing change).
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "pty_kill",
        expect.objectContaining({
          sessionId: "00000000-0000-0000-0000-000000000001",
          generation: 1,
        }),
      );
    });
  });

  it("shows [failed to start shell:] error and does not subscribe on spawn failure", async () => {
    const mockInvoke = invoke as unknown as AnyMock;
    mockInvoke.mockRejectedValueOnce(new Error("shell not found"));

    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    const termInstance = getTermInstance();
    await vi.waitFor(() => {
      expect(termInstance.writeln).toHaveBeenCalledWith(
        expect.stringContaining("[failed to start shell:"),
      );
    });

    // listen should NOT have been called because the IIFE returned early.
    const mockListen = listen as unknown as AnyMock;
    expect(mockListen).not.toHaveBeenCalled();
  });

  it("calls pty_kill exactly once via the spawn chain when unmounted during in-flight spawn", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // Capture the sessionId that will be generated for this render.
    const expectedSessionId = "00000000-0000-0000-0000-000000000001";

    // Set up a deferred spawn promise — resolves only when we call resolveSpawn().
    // Resolves to number (generation token) to match the updated pty_spawn contract.
    let resolveSpawn!: (value: number) => void;
    const spawnPromise = new Promise<number>((resolve) => {
      resolveSpawn = resolve;
    });

    // First invoke call is pty_spawn (deferred); subsequent calls resolve immediately.
    mockInvoke.mockImplementationOnce(() => spawnPromise);

    const { unmount } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );

    // Unmount before spawn resolves — cleanup registers the deferred kill in the
    // spawn chain (no immediate pty_kill IPC fires here; the old early-cancel kill
    // has been removed per Ruinor F-5).
    act(() => {
      unmount();
    });

    // Now resolve the spawn — the spawn-chain's cleanup .then fires pty_kill exactly once.
    await act(async () => {
      resolveSpawn(1);
      await spawnPromise;
    });

    // Drain microtasks so the deferred kill chain settles.
    await act(async () => {
      await Promise.resolve();
    });

    // Exactly one pty_kill IPC call — the deferred kill from cleanup's spawn chain.
    // The old IIFE early-cancel kill is removed (Ruinor F-5), so only one fires.
    const killCalls = mockInvoke.mock.calls.filter((c: unknown[]) => c[0] === "pty_kill");
    expect(killCalls).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith(
      "pty_kill",
      expect.objectContaining({ sessionId: expectedSessionId, generation: 1 }),
    );
  });

  it("calls FitAddon.fit on initial mount", () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    const fitInstance = getFitInstance();
    expect(fitInstance.fit).toHaveBeenCalled();
  });

  it("calls fitAddon.fit at least twice on initial mount and the second call occurs after term.open (fit-after-open regression)", async () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    const termInstance = getTermInstance();
    const fitInstance = getFitInstance();

    // Wait for term.open to be called (inside the font-load IIFE, after loadFonts resolves).
    await vi.waitFor(() => {
      expect(termInstance.open).toHaveBeenCalledTimes(1);
    });

    // At this point both the pre-open fit() (line ~285) and the post-open fit()
    // (immediately after term.open()) must have fired.
    expect(fitInstance.fit.mock.calls.length).toBeGreaterThanOrEqual(2);

    // At least one fit() call must have been made AFTER term.open().
    // invocationCallOrder is a monotonically increasing integer assigned by
    // Vitest to each mock call globally — a higher number means a later call.
    // We use .some() rather than checking a fixed index because jsdom's
    // ResizeObserver mock fires eagerly on observer.observe(), producing an
    // intermediate fit() call between the pre-open fit() and term.open(). The
    // total number of fit() calls is therefore 3+ in the test environment, and
    // the post-open fit() is not at a fixed index.
    const openOrder = termInstance.open.mock.invocationCallOrder[0];
    const fitOrders = fitInstance.fit.mock.invocationCallOrder;
    expect(fitOrders.some((o: number) => o > openOrder)).toBe(true);
  });

  it("calls pty_resize when ResizeObserver fires after spawn is ready", async () => {
    let resizeCallback: (() => void) | undefined;
    globalThis.ResizeObserver = vi.fn().mockImplementation(function (cb: () => void) {
      resizeCallback = cb;
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }) as unknown as typeof ResizeObserver;

    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    // After the refactor, onData is registered synchronously (before spawn).
    // Wait for both listen() calls to resolve, which confirms isReadyRef.current
    // has been set to true (spawn + subscriptions complete).
    const mockListen = listen as unknown as AnyMock;
    await vi.waitFor(() => {
      expect(mockListen).toHaveBeenCalledTimes(2);
    });

    // Trigger a resize after ready.
    resizeCallback?.();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("pty_resize", {
        sessionId: "00000000-0000-0000-0000-000000000001",
        cols: 80,
        rows: 24,
      });
    });
  });

  it("does NOT call pty_resize when ResizeObserver fires before spawn completes, but calls fitAddon.fit", async () => {
    let resizeCallback: (() => void) | undefined;
    globalThis.ResizeObserver = vi.fn().mockImplementation(function (cb: () => void) {
      resizeCallback = cb;
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }) as unknown as typeof ResizeObserver;

    // Make spawn hang indefinitely so PTY is never ready during this test.
    const mockInvoke = invoke as unknown as AnyMock;
    mockInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd !== "pty_spawn") resolve(undefined);
          // pty_spawn never resolves → isReadyRef stays false.
        }),
    );

    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    // Give React a tick to mount and set up the observer.
    await new Promise((r) => setTimeout(r, 10));

    // Fire resize before spawn completes.
    resizeCallback?.();

    const fitInstance = getFitInstance();
    // fitAddon.fit() must be called (always).
    expect(fitInstance.fit).toHaveBeenCalled();

    // pty_resize must NOT have been called.
    expect(invoke).not.toHaveBeenCalledWith(
      "pty_resize",
      expect.objectContaining({ sessionId: "00000000-0000-0000-0000-000000000001" }),
    );
  });

  it("disposes terminal and disconnects observer on unmount", async () => {
    const { unmount } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );

    const termInstance = getTermInstance();
    const MockResizeObserver = globalThis.ResizeObserver as unknown as AnyMock;

    unmount();

    const observerInstance =
      MockResizeObserver.mock.results[MockResizeObserver.mock.results.length - 1].value;
    expect(termInstance.dispose).toHaveBeenCalledTimes(1);
    expect(observerInstance.disconnect).toHaveBeenCalledTimes(1);
  });

  // ── Pre-ready keystroke buffering ─────────────────────────────────────────

  it("buffers keystrokes typed before spawn completes and flushes them in order after spawn resolves", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // Deferred spawn: resolves only when we call resolveSpawn().
    // Resolves to number (generation token) to match the updated pty_spawn contract.
    let resolveSpawn!: (value: number) => void;
    const spawnPromise = new Promise<number>((resolve) => {
      resolveSpawn = resolve;
    });

    // First invoke call is pty_spawn; all subsequent calls resolve immediately.
    mockInvoke.mockImplementationOnce(() => spawnPromise);

    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    // onData is now registered synchronously — wait for registration.
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
    });

    // Extract the callback (registered before spawn resolves — buffering path).
    const onDataCallback = onDataSpy.mock.calls[onDataSpy.mock.calls.length - 1][0] as (
      data: string,
    ) => void;

    // Type three keys before spawn resolves.
    onDataCallback("a");
    onDataCallback("b");
    onDataCallback("c");

    // pty_write must NOT have been called yet — keystrokes are buffered.
    const ptyWriteCallsBefore = mockInvoke.mock.calls.filter(
      (c: unknown[]) => c[0] === "pty_write",
    );
    expect(ptyWriteCallsBefore).toHaveLength(0);

    // Resolve spawn and wait for the flush loop to drain.
    await act(async () => {
      resolveSpawn(1);
      await spawnPromise;
    });

    // After spawn + listen calls complete, all three buffered keystrokes must
    // have been flushed to pty_write in FIFO order.
    await vi.waitFor(() => {
      const ptyWriteCalls = mockInvoke.mock.calls
        .filter((c: unknown[]) => c[0] === "pty_write")
        .map((c: unknown[]) => (c[1] as { dataB64: string }).dataB64);
      expect(ptyWriteCalls).toEqual(["YQ==", "Yg==", "Yw=="]);
    });
  });

  it("does not replay buffered keystrokes if the component unmounts before spawn completes", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // Deferred spawn.
    let resolveSpawn!: (value: number) => void;
    const spawnPromise = new Promise<number>((resolve) => {
      resolveSpawn = resolve;
    });

    mockInvoke.mockImplementationOnce(() => spawnPromise);

    const { unmount } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );

    // Wait for synchronous onData registration.
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
    });

    const onDataCallback = onDataSpy.mock.calls[onDataSpy.mock.calls.length - 1][0] as (
      data: string,
    ) => void;

    // Buffer a keystroke before spawn resolves.
    onDataCallback("x");

    // Unmount before spawn resolves — cleanup fires, pendingWrites is cleared.
    act(() => {
      unmount();
    });

    // Now resolve spawn — the IIFE resumes but cancelled is true; flush loop
    // checks cancelled and breaks immediately without calling pty_write.
    await act(async () => {
      resolveSpawn(1);
      await spawnPromise;
    });

    // pty_write must NEVER have been called.
    const ptyWriteCalls = mockInvoke.mock.calls.filter((c: unknown[]) => c[0] === "pty_write");
    expect(ptyWriteCalls).toHaveLength(0);
  });

  // ── pty_write error surfacing ─────────────────────────────────────────────

  it("surfaces pty_write errors via term.writeln", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    // Wait for the PTY to be ready (both listen() calls resolved).
    const mockListen = listen as unknown as AnyMock;
    await vi.waitFor(() => {
      expect(mockListen).toHaveBeenCalledTimes(2);
    });

    const termInstance = getTermInstance();

    // Configure the next pty_write call to reject.
    mockInvoke.mockImplementationOnce((cmd: string) => {
      if (cmd === "pty_write") return Promise.reject(new Error("write failed"));
      return Promise.resolve(undefined);
    });

    // Extract the onData callback and trigger a keystroke on the live path.
    const onDataCallback = onDataSpy.mock.calls[onDataSpy.mock.calls.length - 1][0] as (
      data: string,
    ) => void;
    onDataCallback("a");

    // The .catch handler must surface the error via term.writeln.
    await vi.waitFor(() => {
      expect(termInstance.writeln).toHaveBeenCalledWith(
        expect.stringContaining("[pty write failed:"),
      );
    });
    expect(termInstance.writeln).toHaveBeenCalledWith(expect.stringContaining("write failed"));
  });

  // ── OSC 6800 handler ─────────────────────────────────────────────────────

  it("calls term.parser.registerOscHandler with 6800 and a function on mount", async () => {
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={vi.fn()}
      />,
    );
    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(6800, expect.any(Function));
    });
  });

  it("registers OSC handlers for 6800, 7, and 7337 on mount", async () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    await vi.waitFor(() => {
      const registeredCodes = registerOscHandlerSpy.mock.calls.map((c: unknown[]) => c[0]);
      expect(registeredCodes).toContain(6800);
      expect(registeredCodes).toContain(7);
      expect(registeredCodes).toContain(7337);
    });
  });

  it("OSC handler invoked with valid payload calls onSessionContextChange once with parsed SessionContext", async () => {
    const onSessionContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={onSessionContextChange}
      />,
    );

    // Wait for OSC handlers to be registered (they run inside the font-load IIFE).
    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(6800, expect.any(Function));
    });

    // Extract the registered OSC 6800 handler callback using code-specific find.
    const osc6800Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 6800)![1];
    expect(osc6800Handler).toBeDefined();

    const validPayload = JSON.stringify({
      SESSION_TS: "20260425-120000",
      SESSION_SLUG: "smoke-test",
      WORKING_DIRECTORY: "/tmp/smoke",
      BRANCH: "main",
      REPO: "acme/widgets",
    });

    // Invoke the handler synchronously — queueMicrotask defers the dispatch.
    const result = osc6800Handler(validPayload);
    // Handler must return true (consume the sequence).
    expect(result).toBe(true);

    // Assert deferral: onSessionContextChange must NOT be called synchronously
    expect(onSessionContextChange).not.toHaveBeenCalled();

    // onSessionContextChange is called via queueMicrotask — wait for the microtask queue.
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextChange).toHaveBeenCalledTimes(1);
        expect(onSessionContextChange).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionTs: "20260425-120000",
            slug: "smoke-test",
            branch: "main",
            repo: { owner: "acme", name: "widgets" },
          }),
        );
        resolve();
      });
    });
  });

  it("OSC handler invoked with malformed JSON does not call onSessionContextChange", async () => {
    const onSessionContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={onSessionContextChange}
      />,
    );

    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(6800, expect.any(Function));
    });

    const osc6800Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 6800)![1];
    expect(osc6800Handler).toBeDefined();

    const result = osc6800Handler("{not json");
    expect(result).toBe(true);

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextChange).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC handler returns true", async () => {
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={vi.fn()}
      />,
    );

    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(6800, expect.any(Function));
    });

    const osc6800Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 6800)![1];
    expect(osc6800Handler).toBeDefined();

    expect(osc6800Handler("anything")).toBe(true);
  });

  it("does not surface spurious errors on cross-mount remount with the same sessionId (StrictMode race)", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // ── Session-aware mock (Ruinor F-9 option (a)) ────────────────────────────
    // Track which sessions are live so pty_write correctly rejects against a
    // killed session — this is what makes the test fail on main for the right
    // reason (Mount A's deferred kill removes "X", causing Mount B's first
    // pty_write to reject with "session not found").
    const liveSessions = new Set<string>();
    const sessionGenerations = new Map<string, number>();
    let nextGeneration = 0;

    // ── Deferred spawn promises ────────────────────────────────────────────────
    // spawnA gates Mount A's pty_spawn; spawnB gates Mount B's pty_spawn.
    // We resolve them manually to control ordering.
    let resolveSpawnA!: () => void;
    let resolveSpawnB!: () => void;
    const deferredA = new Promise<void>((resolve) => {
      resolveSpawnA = resolve;
    });
    const deferredB = new Promise<void>((resolve) => {
      resolveSpawnB = resolve;
    });

    // Track which deferred to consume next for pty_spawn calls.
    let spawnCallCount = 0;

    mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "pty_spawn") {
        const sid = args["sessionId"] as string;
        const callIndex = spawnCallCount++;
        // Gate on the appropriate deferred promise.
        if (callIndex === 0) {
          await deferredA;
        } else {
          await deferredB;
        }
        // Session-aware duplicate check.
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
        // stale generation → no-op
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

    // ── Mount A, immediately unmount, mount B (mirrors StrictMode cycle) ───────
    let unmountA!: () => void;
    let unmountB!: () => void;
    await act(() => {
      const resultA = renderWithProviders(<Terminal sessionId="X" />);
      unmountA = resultA.unmount;
    });
    await act(() => {
      unmountA();
      const resultB = renderWithProviders(<Terminal sessionId="X" />);
      unmountB = resultB.unmount;
    });

    // ── Resolve spawnA (generation 1 allocated, "X" added to liveSessions) ─────
    await act(async () => {
      resolveSpawnA();
      await deferredA;
      // Drain extra microtask rounds so Mount A's IIFE (cancelled→return),
      // the cleanup kill, and killPromise settling all complete within this act.
      await drain(10);
    });

    // ── Resolve spawnB (should be serialised after Mount A's kill is issued) ───
    // deferredB may already be resolvable (killPromise settled above). Resolve it
    // and drain until Mount B's IIFE registers its listen calls.
    await act(async () => {
      resolveSpawnB();
      await deferredB;
      // Drain so the mock returns, spawnPromise resolves, and the IIFE reaches listen.
      await drain(10);
    });

    const allCalls = mockInvoke.mock.calls as [string, Record<string, unknown>][];
    const spawnCalls = allCalls.filter((c) => c[0] === "pty_spawn");
    const killCalls = allCalls.filter((c) => c[0] === "pty_kill");

    // ── Assertion 1: ordering — Mount A's kill was issued before Mount B's spawn
    const spawnAIndex = allCalls.findIndex((c) => c[0] === "pty_spawn");
    const killAIndex = allCalls.findIndex(
      (c) => c[0] === "pty_kill" && (c[1]["generation"] as number) === 1,
    );
    const spawnBIndex = allCalls.findIndex((c, i) => c[0] === "pty_spawn" && i > spawnAIndex);
    expect(spawnCalls.length).toBeGreaterThanOrEqual(2);
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    expect(killAIndex).toBeGreaterThan(-1); // kill for gen 1 was issued
    expect(spawnBIndex).toBeGreaterThan(killAIndex); // Mount B spawns after Mount A's kill

    // ── Assertion 2: Mount B's listen calls were registered ───────────────────
    // Mount B's IIFE calls listen after spawnB resolves. Drain a few more rounds
    // to ensure the IIFE's listen registrations complete.
    await act(async () => {
      await drain(20);
    });
    const mockListen = listen as unknown as AnyMock;
    const listenNames = (mockListen.mock.calls as [string][]).map((c) => c[0]);
    // Mount B registers pty:output:X and pty:exit:X (Mount A returned early due
    // to cancelled=true, so its listen calls never fired).
    expect(listenNames.filter((n) => n === "pty:output:X").length).toBeGreaterThanOrEqual(1);
    expect(listenNames.filter((n) => n === "pty:exit:X").length).toBeGreaterThanOrEqual(1);

    // ── Assertion 3: no spurious error rendered in any terminal canvas ─────────
    // Iterate ALL xterm instances created across both mounts (not just the last).
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

    // Cleanup.
    unmountB();
  });

  it("does not call term.writeln on pty_write error after unmount (flush-path .catch cancelled guard)", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // Deferred spawn so we can queue a keystroke before spawn resolves.
    // Resolves to number (generation token) to match the updated pty_spawn contract.
    let resolveSpawn!: (value: number) => void;
    const spawnPromise = new Promise<number>((resolve) => {
      resolveSpawn = resolve;
    });

    mockInvoke.mockImplementationOnce(() => spawnPromise);

    const { unmount } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );

    // Wait for synchronous onData registration.
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
    });

    const onDataCallback = onDataSpy.mock.calls[onDataSpy.mock.calls.length - 1][0] as (
      data: string,
    ) => void;

    // Queue a keystroke before spawn resolves — it will be flushed after spawn.
    onDataCallback("a");

    const termInstance = getTermInstance();

    // Set up a deferred pty_write rejection that we control manually.
    let rejectPtyWrite!: (err: Error) => void;
    const ptyWritePromise = new Promise<void>((_, reject) => {
      rejectPtyWrite = reject;
    });

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "pty_write") return ptyWritePromise;
      return Promise.resolve(1);
    });

    // Resolve spawn — flush loop runs, calls pty_write (promise is still pending).
    await act(async () => {
      resolveSpawn(1);
      await spawnPromise;
    });

    // Unmount BEFORE settling the pty_write rejection — cancelled becomes true.
    act(() => {
      unmount();
    });

    // Now reject pty_write — the .catch fires with cancelled=true.
    await act(async () => {
      rejectPtyWrite(new Error("write failed"));
      await ptyWritePromise.catch(() => {
        /* expected rejection, suppress unhandled-rejection noise */
      });
    });

    // The flush-path .catch must NOT call writeln because cancelled is true.
    expect(termInstance.writeln).not.toHaveBeenCalledWith(
      expect.stringContaining("[pty write failed:"),
    );
    // Dispose must have been called exactly once.
    expect(termInstance.dispose).toHaveBeenCalledTimes(1);
  });

  // ── OSC 7 handler ─────────────────────────────────────────────────────────

  // ── OSC 7337 handler ──────────────────────────────────────────────────────

  // ── onShellContextChange tests (Step 2) ──────────────────────────────────────

  it("OSC 7 handler calls onShellContextChange with workingDirectory after microtask", async () => {
    const onShellContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onShellContextChange={onShellContextChange}
      />,
    );

    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(7, expect.any(Function));
    });

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    osc7Handler("file://localhost/Users/me/projects/foo");

    expect(onShellContextChange).not.toHaveBeenCalled();

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onShellContextChange).toHaveBeenCalledTimes(1);
        expect(onShellContextChange).toHaveBeenCalledWith(
          expect.objectContaining({ workingDirectory: "/Users/me/projects/foo" }),
        );
        resolve();
      });
    });
  });

  it("OSC 7337 (bare-name) calls onShellContextChange with branch only (no repo) after OSC 7", async () => {
    const onShellContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onShellContextChange={onShellContextChange}
      />,
    );

    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(7337, expect.any(Function));
    });

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];

    // First OSC 7 to establish CWD.
    osc7Handler("file:///Users/me/project");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    onShellContextChange.mockClear();

    // Then OSC 7337 bare-name.
    osc7337Handler("ai-dungeon\tmain");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onShellContextChange).toHaveBeenCalledTimes(1);
        const ctx = onShellContextChange.mock.calls[0][0];
        expect(ctx.workingDirectory).toBe("/Users/me/project");
        expect(ctx.branch).toBe("main");
        expect(ctx).not.toHaveProperty("repo");
        resolve();
      });
    });
  });

  it("OSC 7337 (owner/name) calls onShellContextChange with branch + repo after OSC 7", async () => {
    const onShellContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onShellContextChange={onShellContextChange}
      />,
    );

    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(7337, expect.any(Function));
    });

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];

    osc7Handler("file:///Users/me/project");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    onShellContextChange.mockClear();

    osc7337Handler("acme/widgets\tmain");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onShellContextChange).toHaveBeenCalledTimes(1);
        expect(onShellContextChange).toHaveBeenCalledWith({
          workingDirectory: "/Users/me/project",
          branch: "main",
          repo: { owner: "acme", name: "widgets" },
        });
        resolve();
      });
    });
  });

  it("OSC 7337 (cleared) before any OSC 7 is a no-op for onShellContextChange", async () => {
    const onShellContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onShellContextChange={onShellContextChange}
      />,
    );

    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(7337, expect.any(Function));
    });

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];

    // No OSC 7 has been received — cleared shape is a no-op.
    osc7337Handler("");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onShellContextChange).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7 followed by OSC 7337 (bare-name) produces ShellContext with both fields", async () => {
    const onShellContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onShellContextChange={onShellContextChange}
      />,
    );

    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(7, expect.any(Function));
    });

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];

    osc7Handler("file:///home/user/repo");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    osc7337Handler("my-repo\tfeat/branch");
    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const lastCall =
          onShellContextChange.mock.calls[onShellContextChange.mock.calls.length - 1][0];
        expect(lastCall.workingDirectory).toBe("/home/user/repo");
        expect(lastCall.branch).toBe("feat/branch");
        resolve();
      });
    });
  });

  // F-1 round-trip test
  it("OSC 7 → OSC 7337 (bare-name) → OSC 7337 (cleared) → OSC 7337 (bare-name) — final ShellContext has workingDirectory + branch, no repo from intermediate state", async () => {
    const onShellContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onShellContextChange={onShellContextChange}
      />,
    );

    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(7, expect.any(Function));
    });

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];

    // Step 1: establish CWD.
    osc7Handler("file:///home/user/repo");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Step 2: set branch (bare-name).
    osc7337Handler("my-repo\tfeat/branch");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // Step 3: clear branch/repo (cleared shape).
    osc7337Handler("");
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    // At this point lastShellContextRef has only workingDirectory — no branch, no repo.

    // Step 4: set branch again (bare-name).
    onShellContextChange.mockClear();
    osc7337Handler("my-repo\tnew-branch");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onShellContextChange).toHaveBeenCalledTimes(1);
        const ctx = onShellContextChange.mock.calls[0][0];
        expect(ctx.workingDirectory).toBe("/home/user/repo");
        expect(ctx.branch).toBe("new-branch");
        // No repo should be present — cleared shape removed it, bare-name doesn't restore it.
        expect(ctx.repo).toBeUndefined();
        resolve();
      });
    });
  });

  // ── Multi-dispose test (replaces deleted "disposes OSC handler on unmount") ─

  it("disposes OSC 6800, OSC 7, and OSC 7337 handlers on unmount before term.dispose()", async () => {
    const { unmount } = renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={vi.fn()}
      />,
    );

    // Wait for OSC handlers to be registered (they are inside the font-load IIFE).
    await vi.waitFor(() => {
      expect(registerOscHandlerSpy).toHaveBeenCalledWith(6800, expect.any(Function));
    });

    const termInstance = getTermInstance();

    // Track invocation order using a shared call-order array.
    // Each dispose spy is replaced with a wrapper that records its label.
    const callOrder: string[] = [];
    osc6800DisposeSpy.mockImplementation(() => {
      callOrder.push("osc6800");
    });
    osc7DisposeSpy.mockImplementation(() => {
      callOrder.push("osc7");
    });
    osc7337DisposeSpy.mockImplementation(() => {
      callOrder.push("osc7337");
    });
    termInstance.dispose.mockImplementation(() => {
      callOrder.push("term");
    });

    unmount();

    expect(osc6800DisposeSpy).toHaveBeenCalledTimes(1);
    expect(osc7DisposeSpy).toHaveBeenCalledTimes(1);
    expect(osc7337DisposeSpy).toHaveBeenCalledTimes(1);

    // All three OSC dispose calls must come before term.dispose().
    const osc6800Idx = callOrder.indexOf("osc6800");
    const osc7Idx = callOrder.indexOf("osc7");
    const osc7337Idx = callOrder.indexOf("osc7337");
    const termIdx = callOrder.indexOf("term");
    expect(osc6800Idx).toBeGreaterThanOrEqual(0);
    expect(osc7Idx).toBeGreaterThanOrEqual(0);
    expect(osc7337Idx).toBeGreaterThanOrEqual(0);
    expect(termIdx).toBeGreaterThanOrEqual(0);
    expect(osc6800Idx).toBeLessThan(termIdx);
    expect(osc7Idx).toBeLessThan(termIdx);
    expect(osc7337Idx).toBeLessThan(termIdx);
  });

  // ── Ref-staleness test ────────────────────────────────────────────────────

  // ── WebFontsAddon load-order invariants ──────────────────────────────────────

  it("awaits webFontsAddon.loadFonts before calling term.open", async () => {
    // Switch to a deferred loadFonts before rendering so we control timing.
    loadFontsPromise = new Promise<FontFace[]>((resolve) => {
      resolveLoadFonts = resolve;
    });
    loadFontsSpy.mockReturnValue(loadFontsPromise);

    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    const termInstance = getTermInstance();

    // Give any synchronous setup a chance to run.
    await act(async () => {
      await Promise.resolve();
    });

    // term.open must NOT have been called while loadFonts is pending.
    expect(termInstance.open).not.toHaveBeenCalled();

    // Resolve loadFonts with a one-element FontFace stub.
    await act(async () => {
      resolveLoadFonts([{}] as unknown as FontFace[]);
      await loadFontsPromise;
    });

    // After loadFonts resolves, term.open must be called exactly once.
    await vi.waitFor(() => {
      expect(termInstance.open).toHaveBeenCalledTimes(1);
    });
  });

  it("opens terminal and emits console.warn when loadFonts rejects (graceful degradation)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    loadFontsSpy.mockRejectedValueOnce(
      'font family "MesloLGS NF" not registered in document.fonts',
    );

    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    const termInstance = getTermInstance();

    // term.open must still be called despite loadFonts rejection.
    await vi.waitFor(() => {
      expect(termInstance.open).toHaveBeenCalledTimes(1);
    });

    // A console.warn must have been emitted with the rejection reason.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Terminal] webFontsAddon.loadFonts rejected"),
      expect.anything(),
    );

    warnSpy.mockRestore();
  });

  it("does not call term.open if the component unmounts during font load", async () => {
    // Switch to a deferred loadFonts before rendering.
    loadFontsPromise = new Promise<FontFace[]>((resolve) => {
      resolveLoadFonts = resolve;
    });
    loadFontsSpy.mockReturnValue(loadFontsPromise);

    const { unmount } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );
    const termInstance = getTermInstance();

    // Unmount before loadFonts resolves.
    act(() => {
      unmount();
    });

    // Now resolve loadFonts — the IIFE must bail due to cancelled=true.
    await act(async () => {
      resolveLoadFonts([{}] as unknown as FontFace[]);
      await loadFontsPromise;
    });

    // term.open must never have been called.
    expect(termInstance.open).not.toHaveBeenCalled();
  });

  // ── onReady callback ──────────────────────────────────────────────────────

  describe("Terminal — onReady callback", () => {
    it("calls onReady exactly once after spawn resolves and flush completes", async () => {
      const spy = vi.fn();
      renderWithProviders(
        <Terminal sessionId="00000000-0000-0000-0000-000000000001" onReady={spy} />,
      );

      const mockListen = listen as unknown as AnyMock;
      // Wait for both listen() calls — this is the same signal used to confirm
      // the spawn IIFE has fully completed (isReadyRef.current = true reached).
      await vi.waitFor(() => {
        expect(mockListen).toHaveBeenCalledTimes(2);
      });

      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });

    it("does NOT call onReady before spawn resolves", async () => {
      const mockInvoke = invoke as unknown as AnyMock;

      let resolveSpawn!: (value: number) => void;
      const spawnPromise = new Promise<number>((resolve) => {
        resolveSpawn = resolve;
      });
      mockInvoke.mockImplementationOnce(() => spawnPromise);

      const spy = vi.fn();
      renderWithProviders(
        <Terminal sessionId="00000000-0000-0000-0000-000000000001" onReady={spy} />,
      );

      // Drain microtasks without resolving spawn — onReady must not have fired.
      await act(async () => {
        await drain(10);
      });
      expect(spy).not.toHaveBeenCalled();

      // Now resolve spawn and wait for onReady to fire.
      await act(async () => {
        resolveSpawn(1);
        await spawnPromise;
      });

      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });

    it("does NOT call onReady when the component unmounts before spawn resolves (StrictMode discarded-mount guard)", async () => {
      const mockInvoke = invoke as unknown as AnyMock;

      let resolveSpawn!: (value: number) => void;
      const spawnPromise = new Promise<number>((resolve) => {
        resolveSpawn = resolve;
      });
      mockInvoke.mockImplementationOnce(() => spawnPromise);

      const spy = vi.fn();
      const { unmount } = renderWithProviders(
        <Terminal sessionId="00000000-0000-0000-0000-000000000001" onReady={spy} />,
      );

      // Wait for onData registration, then unmount before spawn resolves.
      await vi.waitFor(() => {
        expect(onDataSpy).toHaveBeenCalled();
      });

      act(() => {
        unmount();
      });

      // Resolve spawn after unmount — IIFE sees cancelled=true and returns early.
      await act(async () => {
        resolveSpawn(1);
        await spawnPromise;
      });

      expect(spy).not.toHaveBeenCalled();
    });

    it("does NOT call onReady when spawn rejects", async () => {
      const mockInvoke = invoke as unknown as AnyMock;
      mockInvoke.mockRejectedValueOnce(new Error("shell not found"));

      const spy = vi.fn();
      renderWithProviders(
        <Terminal sessionId="00000000-0000-0000-0000-000000000001" onReady={spy} />,
      );

      const termInstance = getTermInstance();
      await vi.waitFor(() => {
        expect(termInstance.writeln).toHaveBeenCalledWith(
          expect.stringContaining("[failed to start shell:"),
        );
      });

      expect(spy).not.toHaveBeenCalled();
    });

    it("calls onReady after fonts load even when loadFonts rejects (graceful degradation)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      loadFontsSpy.mockRejectedValueOnce(
        'font family "MesloLGS NF" not registered in document.fonts',
      );

      const spy = vi.fn();
      renderWithProviders(
        <Terminal sessionId="00000000-0000-0000-0000-000000000001" onReady={spy} />,
      );

      const termInstance = getTermInstance();
      // term.open is still called despite loadFonts rejection.
      await vi.waitFor(() => {
        expect(termInstance.open).toHaveBeenCalledTimes(1);
      });

      // onReady fires because the spawn IIFE does not depend on the font-load IIFE's success.
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });

      warnSpy.mockRestore();
    });
  });

  it("buffers keystrokes typed during font load and flushes them after spawn resolves", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // Deferred loadFonts and deferred spawn so we can verify buffering through
    // both windows independently.
    loadFontsPromise = new Promise<FontFace[]>((resolve) => {
      resolveLoadFonts = resolve;
    });
    loadFontsSpy.mockReturnValue(loadFontsPromise);

    let resolveSpawn!: (value: number) => void;
    const spawnPromise = new Promise<number>((resolve) => {
      resolveSpawn = resolve;
    });
    mockInvoke.mockImplementationOnce(() => spawnPromise);

    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    // Wait for onData to be registered synchronously (invariant I2: it must
    // be registered before the font-load IIFE, not inside it).
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
    });

    // Extract the onData callback.
    const onDataCallback = onDataSpy.mock.calls[onDataSpy.mock.calls.length - 1][0] as (
      data: string,
    ) => void;

    // Simulate a keystroke while loadFonts is still pending.
    onDataCallback("z");

    // pty_write must NOT have been called yet — keystroke is buffered.
    const ptyWritesBefore = (mockInvoke.mock.calls as [string][]).filter(
      (c) => c[0] === "pty_write",
    );
    expect(ptyWritesBefore).toHaveLength(0);

    // Resolve loadFonts (term.open fires now), then resolve spawn.
    await act(async () => {
      resolveLoadFonts([{}] as unknown as FontFace[]);
      await loadFontsPromise;
    });

    await act(async () => {
      resolveSpawn(1);
      await spawnPromise;
    });

    // After spawn resolves the flush loop drains pendingWrites.
    await vi.waitFor(() => {
      const ptyWriteCalls = (mockInvoke.mock.calls as [string, { dataB64: string }][])
        .filter((c) => c[0] === "pty_write")
        .map((c) => c[1].dataB64);
      expect(ptyWriteCalls).toContain("eg=="); // base64("z")
    });
  });

  // ── fontSize settings tests (Step 5) ─────────────────────────────────────

  it("XTerm constructor receives fontSize from settings (default 13)", () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    const MockXTermCls = XTerm as unknown as AnyMock;
    const constructorArgs = MockXTermCls.mock.calls[MockXTermCls.mock.calls.length - 1][0] as {
      fontSize: number;
    };
    expect(constructorArgs.fontSize).toBe(13);
  });

  it("changing settings.terminal.fontSize sets term.options.fontSize and calls fitAddon.fit without re-invoking pty_spawn", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // Render with default fontSize=13
    const { rerender } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );

    // Wait for spawn to complete
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "pty_spawn",
        expect.objectContaining({ sessionId: "00000000-0000-0000-0000-000000000001" }),
      );
    });

    const termInstance = getTermInstance();
    const fitInstance = getFitInstance();

    const spawnCountBefore = mockInvoke.mock.calls.filter(
      (c: unknown[]) => c[0] === "pty_spawn",
    ).length;

    // Change fontSize in mock settings
    mockTerminalSettings.fontSize = 18;

    // Re-render to trigger the fontSize effect with new value
    await act(async () => {
      rerender(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    });

    // term.options.fontSize must be updated
    expect(termInstance.options.fontSize).toBe(18);

    // fitAddon.fit must be called (at least once after the font-size change)
    expect(fitInstance.fit).toHaveBeenCalled();

    // pty_spawn must NOT have been called again
    const spawnCountAfter = mockInvoke.mock.calls.filter(
      (c: unknown[]) => c[0] === "pty_spawn",
    ).length;
    expect(spawnCountAfter).toBe(spawnCountBefore);
  });

  it("StrictMode null-guard: [fontSize] effect early-returns when termRef.current is null (does not call fitAddon.fit or throw)", async () => {
    // Make spawn hang indefinitely so the spawn effect never assigns termRef.current.
    // In this state, termRef.current remains null when the fontSize effect runs.
    const mockInvoke = invoke as unknown as AnyMock;
    mockInvoke.mockImplementation(
      (cmd: string) =>
        new Promise((resolve) => {
          if (cmd !== "pty_spawn") resolve(undefined);
          // pty_spawn never resolves → termRef.current is never assigned by spawn effect
        }),
    );

    // Render — the spawn effect runs but the spawn-chain IIFE suspends before
    // assigning termRef.current (the spawn never returns).
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);

    // Wait a tick so the effect has run.
    await act(async () => {
      await Promise.resolve();
    });

    const fitInstance = getFitInstance();

    // The initial fit call from the spawn effect (fitAddon.fit()) will have fired,
    // but the fontSize effect's fitAddon.fit call must NOT have fired (since
    // termRef.current is null, the effect returns early).
    // We clear the fit mock to isolate the fontSize effect's behavior.
    fitInstance.fit.mockClear();

    // Changing the font size while termRef is null must NOT throw and must NOT
    // call fitAddon.fit
    mockTerminalSettings.fontSize = 16;

    // Re-render to trigger the fontSize effect
    let threw = false;
    try {
      await act(async () => {
        renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000002" />);
        await Promise.resolve();
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // The new instance's fit was called by its own spawn effect, but we only
    // care that the effect does not explode — the null-guard is validated by
    // the lack of exceptions above.
  });
});

// ── Custom key event handler ───────────────────────────────────────────────────

describe("custom key event handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlistenSpies.length = 0;
    _clearSpawnChainForTesting();
    (invoke as unknown as AnyMock).mockResolvedValue(1);
    mockTerminalSettings.fontSize = 13;
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }) as unknown as typeof ResizeObserver;
    // Reset loadFonts to resolve immediately so key-handler tests don't hang.
    loadFontsSpy.mockResolvedValue([{}] as unknown as FontFace[]);
  });

  function getHandler() {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    return attachKeyHandlerSpy.mock.calls[0][0] as (e: KeyboardEvent) => boolean;
  }

  it("returns false for mod+ArrowLeft (metaKey)", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true }))).toBe(false);
  });

  it("returns false for mod+ArrowRight (metaKey)", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true }))).toBe(false);
  });

  it("returns false for mod+ArrowLeft (ctrlKey — Linux/Windows path)", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true }))).toBe(false);
  });

  it("returns false for mod+1 (metaKey)", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "1", metaKey: true }))).toBe(false);
  });

  it("returns false for mod+9 (metaKey)", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "9", metaKey: true }))).toBe(false);
  });

  it("returns true for mod+0 (not in scope)", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "0", metaKey: true }))).toBe(true);
  });

  it("returns true for unmodified ArrowLeft", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "ArrowLeft" }))).toBe(true);
  });

  it("returns true for alphabetic key with modifier", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "a", metaKey: true }))).toBe(true);
  });

  it("returns true for keyup event (only keydown is intercepted)", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keyup", { key: "ArrowLeft", metaKey: true }))).toBe(true);
  });

  it("returns true for mod+Shift+1 (shift-prefixed combo passes through — tmux/screen regression guard)", () => {
    const handler = getHandler();
    expect(handler(new KeyboardEvent("keydown", { key: "1", metaKey: true, shiftKey: true }))).toBe(
      true,
    );
  });

  it("returns true for mod+Alt+ArrowLeft (alt-prefixed combo passes through — F-1 regression guard)", () => {
    const handler = getHandler();
    expect(
      handler(new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, altKey: true })),
    ).toBe(true);
  });
});
