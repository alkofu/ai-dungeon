// Vitest hoists vi.mock() to module scope; invoke mock must be declared before imports.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useDungeonSend } from "./useDungeonSend";

type AnyMock = ReturnType<typeof vi.fn>;

const mockInvoke = invoke as unknown as AnyMock;

describe("useDungeonSend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sendHi() calls invoke with ('dungeon_send', { msg: 'Hi' })", async () => {
    mockInvoke.mockResolvedValue("Hello");

    const { result } = renderHook(() => useDungeonSend());

    await act(async () => {
      await result.current.sendHi();
    });

    expect(mockInvoke).toHaveBeenCalledWith("dungeon_send", { msg: "Hi" });
  });

  it("sendHi() resolves to the value returned by invoke", async () => {
    mockInvoke.mockResolvedValue("Hello");

    const { result } = renderHook(() => useDungeonSend());

    let reply: string | undefined;
    await act(async () => {
      reply = await result.current.sendHi();
    });

    expect(reply).toBe("Hello");
  });

  it("the returned sendHi reference is stable across re-renders", () => {
    const { result, rerender } = renderHook(() => useDungeonSend());

    const firstRef = result.current.sendHi;
    rerender();
    const secondRef = result.current.sendHi;

    expect(firstRef).toBe(secondRef);
  });
});
