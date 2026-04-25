// ── Module-level mocks ────────────────────────────────────────────────────────
// These must be declared before any imports that transitively use the mocked
// modules. Vitest hoists vi.mock() calls to the top of the file.

// M-6: Declare onData spies at module scope so they are stable across
// mount/cleanup boundary assertions (not re-created per test).
const onDataDisposeSpy = vi.fn();
const onDataSpy = vi.fn().mockReturnValue({ dispose: onDataDisposeSpy });

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

    // Restore a fresh ResizeObserver spy for each test.
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }) as unknown as typeof ResizeObserver;

    // Stable UUID for deterministic session ID matching.
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-0000-0000-000000000001",
    );
  });

  it("calls pty_spawn with sessionId, cols, and rows on mount", async () => {
    renderWithProviders(<Terminal />);

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
    renderWithProviders(<Terminal />);

    await vi.waitFor(() => {
      const mockListen = listen as unknown as AnyMock;
      const eventNames = mockListen.mock.calls.map((c: unknown[]) => c[0]);
      expect(eventNames).toContain("pty:output:00000000-0000-0000-0000-000000000001");
      expect(eventNames).toContain("pty:exit:00000000-0000-0000-0000-000000000001");
    });
  });

  it("registers onData handler and forwards input as base64 via pty_write", async () => {
    renderWithProviders(<Terminal />);

    // Wait for the IIFE to complete (isReadyRef set, onData registered).
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
    });

    // Extract the onData callback and simulate a keystroke ('a').
    const onDataCallback = onDataSpy.mock.calls[onDataSpy.mock.calls.length - 1][0] as (
      data: string,
    ) => void;
    onDataCallback("a");

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("pty_write", {
        sessionId: "00000000-0000-0000-0000-000000000001",
        data_b64: "YQ==",
      });
    });
  });

  it("disposes onData, calls unlistens, and invokes pty_kill on unmount", async () => {
    const { unmount } = renderWithProviders(<Terminal />);

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

    renderWithProviders(<Terminal />);

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

  it("calls FitAddon.fit on initial mount", () => {
    renderWithProviders(<Terminal />);
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

    renderWithProviders(<Terminal />);

    // Wait for spawn to complete so isReadyRef.current = true.
    await vi.waitFor(() => {
      expect(onDataSpy).toHaveBeenCalled();
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

    renderWithProviders(<Terminal />);

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
    const { unmount } = renderWithProviders(<Terminal />);

    const termInstance = getTermInstance();
    const MockResizeObserver = globalThis.ResizeObserver as unknown as AnyMock;

    unmount();

    const observerInstance =
      MockResizeObserver.mock.results[MockResizeObserver.mock.results.length - 1].value;
    expect(termInstance.dispose).toHaveBeenCalledTimes(1);
    expect(observerInstance.disconnect).toHaveBeenCalledTimes(1);
  });
});
