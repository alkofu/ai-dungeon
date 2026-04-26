vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    write: vi.fn(),
    writeln: vi.fn(),
    open: vi.fn(),
    loadAddon: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    parser: { registerOscHandler: vi.fn().mockReturnValue({ dispose: vi.fn() }) },
  })),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
    proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockImplementation(() => Promise.resolve(vi.fn())),
}));

import { renderWithProviders } from "../../test-utils/render";
import { AppLayout } from "./AppLayout";

describe("AppLayout", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    })) as unknown as typeof ResizeObserver;
  });

  it("applies flex:1 and minWidth:0 to the AppShell root element", () => {
    const { container } = renderWithProviders(
      <AppLayout
        cards={[]}
        onAddCard={vi.fn()}
        onRemoveCard={vi.fn()}
        activeId={null}
        onActiveIdChange={vi.fn()}
        contexts={{}}
        onContextChange={vi.fn()}
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
});
