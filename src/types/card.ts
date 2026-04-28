// Additional fields (e.g. title, kind) will be added when card content is introduced.
export interface Card {
  id: string;
}

/**
 * Predicate identifying dungeon cards (cards that participate in the Python sidecar lifecycle).
 * Today every card is a dungeon card. When Card.type lands, this becomes `card.type === "dungeon"` — a one-line edit.
 * Do NOT inline this predicate at call sites.
 */
export function isDungeonCard(_card: Card): boolean {
  return true;
}
