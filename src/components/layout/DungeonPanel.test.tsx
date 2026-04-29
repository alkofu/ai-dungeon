// Vitest hoists vi.mock() to module scope; invoke mock must be declared before imports.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test-utils/render";
import { invoke } from "@tauri-apps/api/core";
import { DungeonPanel } from "./DungeonPanel";
import type { Card } from "../../types/card";

type AnyMock = ReturnType<typeof vi.fn>;

const mockInvoke = invoke as unknown as AnyMock;

/** Drain all pending microtasks (Promise chain resolutions). */
async function flushPromises(): Promise<void> {
  await act(async () => {
    await Array.from({ length: 5 }).reduce(
      (chain: Promise<void>) => chain.then(() => Promise.resolve()),
      Promise.resolve(),
    );
  });
}

const dungeonCard: Card = { id: "D", type: "dungeon" };

describe("DungeonPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounting the panel calls invoke('dungeon_open')", async () => {
    await act(async () => {
      renderWithProviders(<DungeonPanel card={dungeonCard} />);
    });

    await flushPromises();

    const openCalls = (mockInvoke.mock.calls as [string][]).filter(
      (call) => call[0] === "dungeon_open",
    );
    expect(openCalls).toHaveLength(1);
  });

  it("unmounting the panel calls invoke('dungeon_close')", async () => {
    let unmount!: () => void;
    await act(async () => {
      const result = renderWithProviders(<DungeonPanel card={dungeonCard} />);
      unmount = result.unmount;
    });

    await flushPromises();

    act(() => {
      unmount();
    });

    await flushPromises();

    const closeCalls = (mockInvoke.mock.calls as [string][]).filter(
      (call) => call[0] === "dungeon_close",
    );
    expect(closeCalls).toHaveLength(1);
  });

  it("clicking 'Hi' calls invoke('dungeon_send', { msg: 'Hi' }) and renders the reply text", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "dungeon_send") return "Hello";
      return undefined;
    });

    const user = userEvent.setup();

    await act(async () => {
      renderWithProviders(<DungeonPanel card={dungeonCard} />);
    });

    await act(async () => {
      await user.click(screen.getByTestId("dungeon-hi-D"));
    });

    await flushPromises();

    expect(mockInvoke).toHaveBeenCalledWith("dungeon_send", { msg: "Hi" });
    expect(screen.getByTestId("dungeon-reply-D")).toBeInTheDocument();
    expect(screen.getByTestId("dungeon-reply-D").textContent).toBe("Hello");
  });

  it("clicking 'Clean' removes the reply text from the DOM", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "dungeon_send") return "Hello";
      return undefined;
    });

    const user = userEvent.setup();

    await act(async () => {
      renderWithProviders(<DungeonPanel card={dungeonCard} />);
    });

    // First click Hi to get a reply.
    await act(async () => {
      await user.click(screen.getByTestId("dungeon-hi-D"));
    });

    await flushPromises();

    expect(screen.getByTestId("dungeon-reply-D")).toBeInTheDocument();

    // Then click Clean to remove it.
    await act(async () => {
      await user.click(screen.getByTestId("dungeon-clean-D"));
    });

    expect(screen.queryByTestId("dungeon-reply-D")).toBeNull();
  });

  it("when invoke rejects, the error text renders and no reply text appears", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "dungeon_send") throw new Error("sidecar reply timeout");
      return undefined;
    });

    const user = userEvent.setup();

    await act(async () => {
      renderWithProviders(<DungeonPanel card={dungeonCard} />);
    });

    await act(async () => {
      await user.click(screen.getByTestId("dungeon-hi-D"));
    });

    await flushPromises();

    expect(screen.queryByTestId("dungeon-reply-D")).toBeNull();
    expect(screen.getByTestId("dungeon-error-D")).toBeInTheDocument();
    expect(screen.getByTestId("dungeon-error-D").textContent).toBe("sidecar reply timeout");
  });
});
