// ── Module-level mocks ────────────────────────────────────────────────────────
// These must be declared before any imports that transitively use the mocked
// modules. Vitest hoists vi.mock() calls to the top of the file.

// M-6: Declare onData spies at module scope so they are stable across
// mount/cleanup boundary assertions (not re-created per test).
const onDataDisposeSpy = vi.fn();
const onDataSpy = vi.fn().mockReturnValue({ dispose: onDataDisposeSpy });

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

  it("calls term.parser.registerOscHandler with 6800 and a function on mount", () => {
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={vi.fn()}
      />,
    );
    expect(registerOscHandlerSpy).toHaveBeenCalledWith(6800, expect.any(Function));
  });

  it("registers OSC handlers for 6800, 7, and 7337 on mount", () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    const registeredCodes = registerOscHandlerSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(registeredCodes).toContain(6800);
    expect(registeredCodes).toContain(7);
    expect(registeredCodes).toContain(7337);
  });

  it("OSC handler invoked with valid payload calls onSessionContextChange once with parsed SessionContext", () => {
    const onSessionContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={onSessionContextChange}
      />,
    );

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

  it("OSC handler invoked with malformed JSON does not call onSessionContextChange", () => {
    const onSessionContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={onSessionContextChange}
      />,
    );

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

  it("OSC handler returns true", () => {
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextChange={vi.fn()}
      />,
    );

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

  it("OSC 7 handler with valid file:// URI calls onSessionContextPatch with decoded workingDirectory after microtask", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    const result = osc7Handler("file://localhost/Users/me/projects/foo");
    expect(result).toBe(true);

    // Must NOT be called synchronously.
    expect(onSessionContextPatch).not.toHaveBeenCalled();

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).toHaveBeenCalledTimes(1);
        expect(onSessionContextPatch).toHaveBeenCalledWith({
          workingDirectory: "/Users/me/projects/foo",
        });
        resolve();
      });
    });
  });

  it("OSC 7 handler with percent-encoded path decodes correctly", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    osc7Handler("file:///Users/me/My%20Projects/foo");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).toHaveBeenCalledWith({
          workingDirectory: "/Users/me/My Projects/foo",
        });
        resolve();
      });
    });
  });

  it("OSC 7 handler with empty-host file URI (file:///path) decodes correctly", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    osc7Handler("file:///Users/me/projects/foo");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).toHaveBeenCalledWith({
          workingDirectory: "/Users/me/projects/foo",
        });
        resolve();
      });
    });
  });

  it("OSC 7 handler with malformed URL does not call onSessionContextPatch", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    osc7Handler("not a url");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7 handler with non-file: scheme does not call onSessionContextPatch", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    const result = osc7Handler("https://example.com/path");
    expect(result).toBe(true);

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7 handler with malformed percent-encoding falls back to raw pathname", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    osc7Handler("file:///bad%path");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).toHaveBeenCalledWith({
          workingDirectory: "/bad%path",
        });
        resolve();
      });
    });
  });

  it("OSC 7 handler with workingDirectory exceeding 1024 chars is silently dropped", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    const result = osc7Handler("file:///" + "a".repeat(2000));
    expect(result).toBe(true);

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7 handler with control characters in path is silently dropped", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    const result = osc7Handler("file:///foo\x01bar");
    expect(result).toBe(true);

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  // ── OSC 7337 handler ──────────────────────────────────────────────────────

  it("OSC 7337 handler with bare repo name (production wire format) calls onSessionContextPatch with branch only", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("ai-dungeon\tmain");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).toHaveBeenCalledTimes(1);
        const patch = onSessionContextPatch.mock.calls[0][0];
        expect(patch).toEqual({ branch: "main" });
        expect(patch).not.toHaveProperty("repo");
        resolve();
      });
    });
  });

  it("OSC 7337 handler with owner/name form calls onSessionContextPatch with full repo + branch", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("acme/widgets\tmain");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).toHaveBeenCalledWith({
          branch: "main",
          repo: { owner: "acme", name: "widgets" },
        });
        resolve();
      });
    });
  });

  it("OSC 7337 handler with empty payload calls onSessionContextPatch with cleared branch and repo", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).toHaveBeenCalledWith({
          branch: undefined,
          repo: undefined,
        });
        resolve();
      });
    });
  });

  it("OSC 7337 handler with malformed payload (no tab) does not call onSessionContextPatch", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("no-tab-here");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7337 handler with empty branch field does not call onSessionContextPatch", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("acme/widgets\t");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7337 handler with empty repo field does not call onSessionContextPatch", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("\tmain");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7337 handler with owner/name where one side is empty does not call onSessionContextPatch", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("/widgets\tmain");

    return new Promise<void>((resolveOuter) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        // Also test the name side empty.
        onSessionContextPatch.mockClear();
        osc7337Handler("acme/\tmain");
        queueMicrotask(() => {
          expect(onSessionContextPatch).not.toHaveBeenCalled();
          resolveOuter();
        });
      });
    });
  });

  it("OSC 7337 handler with branch over 256 chars (bare-name path) is silently dropped", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    const result = osc7337Handler("ai-dungeon\t" + "b".repeat(257));
    expect(result).toBe(true);

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7337 handler with control char in branch is silently dropped", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("ai-dungeon\tma\x01in");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7337 handler with control char in owner segment is silently dropped", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    osc7337Handler("ac\x01me/widgets\tmain");

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
        resolve();
      });
    });
  });

  it("OSC 7337 handler with over-length branch in owner/name path is silently dropped", () => {
    const onSessionContextPatch = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onSessionContextPatch={onSessionContextPatch}
      />,
    );

    const osc7337Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7337)![1];
    expect(osc7337Handler).toBeDefined();

    const result = osc7337Handler("acme/widgets\t" + "b".repeat(257));
    expect(result).toBe(true);

    return new Promise<void>((resolve) => {
      queueMicrotask(() => {
        expect(onSessionContextPatch).not.toHaveBeenCalled();
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

    // Wait for async setup to complete.
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
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

  it("OSC 7 handler always invokes the latest onSessionContextPatch callback after a re-render", async () => {
    const cbA = vi.fn();
    const cbB = vi.fn();

    const { rerender } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" onSessionContextPatch={cbA} />,
    );

    const osc7Handler = registerOscHandlerSpy.mock.calls.find((c) => c[0] === 7)![1];
    expect(osc7Handler).toBeDefined();

    // Fire OSC 7 with cbA and wait for microtask.
    osc7Handler("file:///Users/me/first");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).not.toHaveBeenCalled();

    // Re-render with cbB (fresh callback reference).
    rerender(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" onSessionContextPatch={cbB} />,
    );

    // Fire OSC 7 again — must invoke cbB (latest), not cbA.
    osc7Handler("file:///Users/me/second");
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(cbB).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledWith({ workingDirectory: "/Users/me/second" });
    // cbA must NOT have been called again.
    expect(cbA).toHaveBeenCalledTimes(1);
  });
});

// ── Custom key event handler ───────────────────────────────────────────────────

describe("custom key event handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unlistenSpies.length = 0;
    _clearSpawnChainForTesting();
    (invoke as unknown as AnyMock).mockResolvedValue(1);
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }) as unknown as typeof ResizeObserver;
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
