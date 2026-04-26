import { describe, it, expect } from "vitest";
import { getCycleTargetId, getNumericTargetId } from "./tabNavigation";

const A = { id: "A" };
const B = { id: "B" };
const C = { id: "C" };

describe("getCycleTargetId", () => {
  it("returns null for empty cards array", () => {
    expect(getCycleTargetId([], "A", 1)).toBeNull();
    expect(getCycleTargetId([], "A", -1)).toBeNull();
  });

  it("returns null for one-card array", () => {
    expect(getCycleTargetId([A], "A", 1)).toBeNull();
    expect(getCycleTargetId([A], "A", -1)).toBeNull();
  });

  it("returns next card from middle (direction +1)", () => {
    expect(getCycleTargetId([A, B, C], "B", 1)).toBe("C");
  });

  it("returns previous card from middle (direction -1)", () => {
    expect(getCycleTargetId([A, B, C], "B", -1)).toBe("A");
  });

  it("wraps from last card to first (direction +1)", () => {
    expect(getCycleTargetId([A, B, C], "C", 1)).toBe("A");
  });

  it("wraps from first card to last (direction -1)", () => {
    expect(getCycleTargetId([A, B, C], "A", -1)).toBe("C");
  });

  it("returns null when activeId is null", () => {
    expect(getCycleTargetId([A, B, C], null, 1)).toBeNull();
  });

  it("returns null when activeId is not found in cards (stale id)", () => {
    expect(getCycleTargetId([A, B, C], "Z", 1)).toBeNull();
  });
});

describe("getNumericTargetId", () => {
  it("returns null for empty cards at position 1", () => {
    expect(getNumericTargetId([], 1)).toBeNull();
  });

  it("returns first card at position 1", () => {
    expect(getNumericTargetId([A, B, C], 1)).toBe("A");
  });

  it("returns third card at position 3", () => {
    expect(getNumericTargetId([A, B, C], 3)).toBe("C");
  });

  it("returns null when position exceeds cards.length", () => {
    expect(getNumericTargetId([A, B, C], 4)).toBeNull();
  });

  it("returns ninth card at position 9 with nine cards", () => {
    const nineCards = [
      { id: "1" },
      { id: "2" },
      { id: "3" },
      { id: "4" },
      { id: "5" },
      { id: "6" },
      { id: "7" },
      { id: "8" },
      { id: "9" },
    ];
    expect(getNumericTargetId(nineCards, 9)).toBe("9");
  });

  it("returns null at position 9 with only five cards", () => {
    const fiveCards = [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }];
    expect(getNumericTargetId(fiveCards, 9)).toBeNull();
  });
});
