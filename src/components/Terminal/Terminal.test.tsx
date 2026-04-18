import { renderWithProviders } from "../../test-utils/render";

// Mock the entire @xterm/xterm module with class spies.
// xterm requires real browser layout APIs that jsdom does not implement.
// Vitest globals are enabled (test.globals: true) — no need to import vi here.
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
    };
  }
  return { Terminal: vi.fn().mockImplementation(MockTerminal) };
});

vi.mock("@xterm/addon-fit", () => {
  const fitSpy = vi.fn();
  function MockFitAddon() {
    return { fit: fitSpy };
  }
  return { FitAddon: vi.fn().mockImplementation(MockFitAddon) };
});

import { Terminal } from "./Terminal";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";

type AnyMock = ReturnType<typeof vi.fn>;

describe("Terminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Override ResizeObserver for each test with a fresh spy.
    // Must use a regular function (not an arrow function) so it can be used as a constructor.
    globalThis.ResizeObserver = vi.fn().mockImplementation(function () {
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      };
    }) as unknown as typeof ResizeObserver;
  });

  it("mounts and writes welcome banner", () => {
    const { getByTestId, getAllByTestId } = renderWithProviders(<Terminal />);

    // Verify exactly one terminal-root node (StrictMode guard)
    expect(getAllByTestId("terminal-root")).toHaveLength(1);

    // Verify xterm was opened
    const MockXTerm = XTerm as unknown as AnyMock;
    const termInstance = MockXTerm.mock.results[MockXTerm.mock.results.length - 1].value;
    expect(termInstance.open).toHaveBeenCalledWith(getByTestId("terminal-root"));

    // Verify welcome banner — U+2014 EM DASH must match exactly
    expect(termInstance.writeln).toHaveBeenCalledWith("AI Dungeon Terminal \u2014 ready");
  });

  it("calls FitAddon.fit on initial mount", () => {
    renderWithProviders(<Terminal />);
    const MockFitAddonCls = FitAddon as unknown as AnyMock;
    const fitInstance = MockFitAddonCls.mock.results[MockFitAddonCls.mock.results.length - 1].value;
    expect(fitInstance.fit).toHaveBeenCalled();
  });

  it("disposes terminal and disconnects observer on unmount", () => {
    const { unmount } = renderWithProviders(<Terminal />);
    const MockXTerm = XTerm as unknown as AnyMock;
    const termInstance = MockXTerm.mock.results[MockXTerm.mock.results.length - 1].value;
    const MockResizeObserver = globalThis.ResizeObserver as unknown as AnyMock;
    const observerInstance =
      MockResizeObserver.mock.results[MockResizeObserver.mock.results.length - 1].value;

    unmount();

    expect(termInstance.dispose).toHaveBeenCalledTimes(1);
    expect(observerInstance.disconnect).toHaveBeenCalledTimes(1);
  });
});
