// Vitest hoists vi.mock() to module scope; invoke mock must be declared before imports.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));

import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useDungeonSidecar } from "./useDungeonSidecar";
import type { Card } from "../../types/card";
import * as cardModule from "../../types/card";

type AnyMock = ReturnType<typeof vi.fn>;

const mockInvoke = invoke as unknown as AnyMock;

/** Drain all pending microtasks (Promise chain resolutions). */
async function flushPromises(): Promise<void> {
  await act(async () => {
    // Multiple rounds to drain chained .then()/.catch() microtasks.
    // Use sequential awaiting via Array.reduce to avoid the no-await-in-loop lint rule
    // while preserving the serial microtask-draining semantics.
    // 5 iterations covers the max promise-chain depth:
    // open(.then) + catch + close(.then) + catch = 4 hops; 5 gives one extra for safety.
    await Array.from({ length: 5 }).reduce(
      (chain: Promise<void>) => chain.then(() => Promise.resolve()),
      Promise.resolve(),
    );
  });
}

describe("useDungeonSidecar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restore any spies (e.g. isDungeonCard, console.warn) so they don't
    // bleed into subsequent tests.
    vi.restoreAllMocks();
  });

  it("calls dungeon_open on mount and dungeon_close on unmount", async () => {
    const card: Card = { id: "test-card-1", type: "dungeon" as const };

    const { unmount } = renderHook(() => useDungeonSidecar(card));

    await flushPromises();

    expect(mockInvoke).toHaveBeenCalledWith("dungeon_open");

    unmount();

    await flushPromises();

    expect(mockInvoke).toHaveBeenCalledWith("dungeon_close");
  });

  it("does not call invoke when isDungeonCard returns false", async () => {
    vi.spyOn(cardModule, "isDungeonCard").mockReturnValue(false);

    const card: Card = { id: "non-dungeon-card", type: "terminal" as const };
    const { unmount } = renderHook(() => useDungeonSidecar(card));

    await flushPromises();

    unmount();

    await flushPromises();

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("does not throw and calls console.warn when invoke rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockInvoke.mockRejectedValue(new Error("IPC error"));

    const card: Card = { id: "error-card", type: "dungeon" as const };

    renderHook(() => useDungeonSidecar(card));

    await flushPromises();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dungeon lifecycle"),
      expect.anything(),
    );
  });

  it("calls dungeon_open exactly once when re-rendered with the same card.id", async () => {
    const card: Card = { id: "stable-id", type: "dungeon" as const };

    const { rerender } = renderHook(() => useDungeonSidecar(card));

    await flushPromises();

    // Re-render with the same card object (same id) — effect deps unchanged, no re-fire.
    rerender();

    await flushPromises();

    const openCalls = (mockInvoke.mock.calls as [string][]).filter(
      (call) => call[0] === "dungeon_open",
    );
    expect(openCalls).toHaveLength(1);
  });
});
