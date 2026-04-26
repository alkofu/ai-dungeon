// ── Module-level mocks ────────────────────────────────────────────────────────
// These must be declared before any imports that transitively use the mocked
// modules. Vitest hoists vi.mock() calls to the top of the file.

// M-6: Declare onData spies at module scope so they are stable across
// mount/cleanup boundary assertions (not re-created per test).
const onDataDisposeSpy = vi.fn();
const onDataSpy = vi.fn().mockReturnValue({ dispose: onDataDisposeSpy });

// OSC handler spies — module-scoped so tests can extract registered handlers.
const oscHandlerDisposeSpy = vi.fn();
const registerOscHandlerSpy = vi.fn().mockReturnValue({ dispose: oscHandlerDisposeSpy });

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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
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
import { Terminal } from "./Terminal";
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Terminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear captured unlisten spies from the previous test.
    unlistenSpies.length = 0;

    // Restore invoke to its default behavior (resolves immediately) so that
    // tests which set a persistent mockImplementation (e.g. the "does NOT call
    // pty_resize before spawn completes" test) do not leak state into later
    // tests. vi.clearAllMocks() only clears call history, not implementations.
    (invoke as unknown as AnyMock).mockResolvedValue(undefined);

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

    expect(onDataDisposeSpy).toHaveBeenCalledTimes(1);
    expect(unlisten1).toHaveBeenCalledTimes(1);
    expect(unlisten2).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("pty_kill", {
      sessionId: "00000000-0000-0000-0000-000000000001",
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

  it("calls pty_kill when unmounted during in-flight spawn", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // Capture the sessionId that will be generated for this render.
    const expectedSessionId = "00000000-0000-0000-0000-000000000001";

    // Set up a deferred spawn promise — resolves only when we call resolveSpawn().
    let resolveSpawn!: () => void;
    const spawnPromise = new Promise<void>((resolve) => {
      resolveSpawn = resolve;
    });

    // First invoke call is pty_spawn; subsequent calls (pty_kill) resolve immediately.
    mockInvoke.mockImplementationOnce(() => spawnPromise);

    const { unmount } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );

    // Unmount before spawn resolves — cleanup fires pty_kill (no session yet).
    act(() => {
      unmount();
    });

    // Now resolve the spawn — the async IIFE resumes and must fire pty_kill again
    // because `cancelled` is true.
    await act(async () => {
      resolveSpawn();
      await spawnPromise;
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "pty_kill",
      expect.objectContaining({ sessionId: expectedSessionId }),
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
    let resolveSpawn!: () => void;
    const spawnPromise = new Promise<void>((resolve) => {
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
      resolveSpawn();
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
    let resolveSpawn!: () => void;
    const spawnPromise = new Promise<void>((resolve) => {
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
      resolveSpawn();
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

  // ── OSC handler registration ──────────────────────────────────────────────

  it("registers OSC 7 and OSC 7337 handlers on mount", () => {
    renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />);
    const oscCodes = registerOscHandlerSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(oscCodes).toContain(7);
    expect(oscCodes).toContain(7337);
  });

  it("calls onContextChange with parsed CWD when OSC 7 fires", () => {
    const onContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onContextChange={onContextChange}
      />,
    );

    // Extract the OSC 7 handler by finding the call with first arg === 7.
    const osc7Call = registerOscHandlerSpy.mock.calls.find((c: unknown[]) => c[0] === 7);
    expect(osc7Call).toBeDefined();
    const osc7Handler = osc7Call![1] as (data: string) => boolean | Promise<boolean>;

    osc7Handler("file://localhost/Users/me/projects/foo");

    expect(onContextChange).toHaveBeenCalledWith({ cwd: "/Users/me/projects/foo", git: null });
  });

  it("calls onContextChange with parsed git context when OSC 7337 fires (non-empty payload)", () => {
    const onContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onContextChange={onContextChange}
      />,
    );

    // Fire OSC 7 first to establish a CWD (lastCwd).
    const osc7Call = registerOscHandlerSpy.mock.calls.find((c: unknown[]) => c[0] === 7);
    const osc7Handler = osc7Call![1] as (data: string) => boolean | Promise<boolean>;
    osc7Handler("file://localhost/Users/me/projects/foo");

    // Extract and fire the OSC 7337 handler.
    const osc7337Call = registerOscHandlerSpy.mock.calls.find((c: unknown[]) => c[0] === 7337);
    expect(osc7337Call).toBeDefined();
    const osc7337Handler = osc7337Call![1] as (data: string) => boolean | Promise<boolean>;

    osc7Handler("file://localhost/Users/me/projects/foo");
    osc7337Handler("my-repo\tmain");

    expect(onContextChange).toHaveBeenLastCalledWith({
      cwd: "/Users/me/projects/foo",
      git: { repo: "my-repo", branch: "main" },
    });
  });

  it("calls onContextChange with git: null when OSC 7337 fires with empty payload", () => {
    const onContextChange = vi.fn();
    renderWithProviders(
      <Terminal
        sessionId="00000000-0000-0000-0000-000000000001"
        onContextChange={onContextChange}
      />,
    );

    // First set a non-null git context.
    const osc7337Call = registerOscHandlerSpy.mock.calls.find((c: unknown[]) => c[0] === 7337);
    const osc7337Handler = osc7337Call![1] as (data: string) => boolean | Promise<boolean>;
    osc7337Handler("my-repo\tmain");

    // Now fire with empty payload — git should become null.
    osc7337Handler("");

    expect(onContextChange).toHaveBeenLastCalledWith({ cwd: null, git: null });
  });

  it("OSC handlers are disposed on unmount", () => {
    const { unmount } = renderWithProviders(
      <Terminal sessionId="00000000-0000-0000-0000-000000000001" />,
    );

    unmount();

    // Each registered handler returns { dispose: oscHandlerDisposeSpy }; both
    // should be disposed once (one for OSC 7, one for OSC 7337).
    expect(oscHandlerDisposeSpy).toHaveBeenCalledTimes(2);
  });

  it("does not call term.writeln on pty_write error after unmount (flush-path .catch cancelled guard)", async () => {
    const mockInvoke = invoke as unknown as AnyMock;

    // Deferred spawn so we can queue a keystroke before spawn resolves.
    let resolveSpawn!: () => void;
    const spawnPromise = new Promise<void>((resolve) => {
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
      return Promise.resolve(undefined);
    });

    // Resolve spawn — flush loop runs, calls pty_write (promise is still pending).
    await act(async () => {
      resolveSpawn();
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
});
