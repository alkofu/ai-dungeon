import type { Card } from "../../types/card";

/**
 * Returns the id of the card that should become active when the user
 * presses mod+ArrowLeft or mod+ArrowRight. Wraps around at the
 * boundaries. Returns null when cycling is not possible (no cards) or
 * pointless (one card, or activeId not found in cards).
 *
 * direction: -1 for previous (mod+ArrowLeft), +1 for next (mod+ArrowRight).
 */
export function getCycleTargetId(
  cards: Card[],
  activeId: string | null,
  direction: -1 | 1,
): string | null {
  if (cards.length < 2) return null;
  if (activeId === null) return null;
  const currentIndex = cards.findIndex((c) => c.id === activeId);
  if (currentIndex === -1) return null;
  const nextIndex = (currentIndex + direction + cards.length) % cards.length;
  return cards[nextIndex].id;
}

/**
 * Returns the id of the card at the given 1-based position, or null when
 * the position exceeds cards.length or cards is empty.
 *
 * position: integer in [1, 9]; behaviour for values outside this range is
 * undefined (the caller is the hotkey registration which only passes
 * 1..9).
 */
export function getNumericTargetId(cards: Card[], position: number): string | null {
  if (position < 1 || position > cards.length) return null;
  return cards[position - 1].id;
}
