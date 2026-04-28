// `type` is a literal-union discriminator field set at creation and never mutated.
// Additional kind-specific fields will be added in a future change; if that happens,
// this tagged interface should be converted to a proper discriminated union.
export type CardType = "terminal" | "dungeon";

export interface Card {
  id: string;
  type: CardType;
}

/**
 * Predicate identifying dungeon cards (cards that participate in the Python sidecar lifecycle).
 * Do NOT inline this predicate at call sites.
 */
export function isDungeonCard(card: Card): boolean {
  return card.type === "dungeon";
}
