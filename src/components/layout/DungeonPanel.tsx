import { useState } from "react";
import { Button, Group, Stack, Text } from "@mantine/core";
import type { Card } from "../../types/card";
import { useDungeonSidecar } from "../Terminal/useDungeonSidecar";
import { useDungeonSend } from "../Terminal/useDungeonSend";

interface DungeonPanelProps {
  card: Card;
}

export function DungeonPanel({ card }: DungeonPanelProps) {
  useDungeonSidecar(card);
  const { sendHi } = useDungeonSend();
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onHi = async () => {
    setError(null);
    try {
      const r = await sendHi();
      setReply(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onClean = () => {
    setReply(null);
    setError(null);
  };

  return (
    <Stack data-testid={`dungeon-panel-${card.id}`}>
      <Text data-testid={`dungeon-placeholder-${card.id}`} c="dimmed">
        Dungeon: under construction
      </Text>
      <Group>
        <Button data-testid={`dungeon-hi-${card.id}`} onClick={onHi}>
          Hi
        </Button>
        <Button data-testid={`dungeon-clean-${card.id}`} onClick={onClean} variant="default">
          Clean
        </Button>
      </Group>
      {reply !== null && <Text data-testid={`dungeon-reply-${card.id}`}>{reply}</Text>}
      {error !== null && (
        <Text data-testid={`dungeon-error-${card.id}`} c="red">
          {error}
        </Text>
      )}
    </Stack>
  );
}
