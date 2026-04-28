import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Card } from "../../types/card";
import { isDungeonCard } from "../../types/card";

export function useDungeonSidecar(card: Card): void {
  // Serialization chain: ensures dungeon_close always waits for its paired dungeon_open
  // to settle before sending its own IPC. This prevents StrictMode's rapid mount/unmount
  // from delivering close before open at the Rust backend, which would corrupt open_count.
  // Mirrors the spawnChain pattern in Terminal.tsx.
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!isDungeonCard(card)) return;

    chainRef.current = chainRef.current
      .then(() => invoke<void>("dungeon_open"))
      .catch((err) => console.warn("[ai-dungeon] dungeon lifecycle invoke failed:", err));

    const openPromise = chainRef.current;

    return () => {
      chainRef.current = openPromise
        .then(() => invoke<void>("dungeon_close"))
        .catch((err) => console.warn("[ai-dungeon] dungeon lifecycle invoke failed:", err));
    };
    // [card.id] is the only dep: the effect's lifecycle is keyed on card identity, not card
    // content. isDungeonCard currently reads no card properties (returns true for all cards),
    // so the extra dep is intentional and safe. When Card.type lands, this dep array must be
    // revisited — isDungeonCard will then read card.type and [card.id, card.type] will be correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);
}
