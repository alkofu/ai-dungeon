import { ActionIcon, Group, Tabs, Text, Title } from "@mantine/core";
import type { Card } from "../../types/card";
import { SessionCard } from "./SessionCard";

interface NavBarProps {
  cards: Card[];
  onAddCard: () => void;
  onRemoveCard: (id: string) => void;
}

export function NavBar({ cards, onAddCard, onRemoveCard }: NavBarProps) {
  return (
    <>
      <Group justify="space-between">
        <Title order={5}>Cards</Title>
        <ActionIcon aria-label="Add card" variant="default" onClick={onAddCard}>
          +
        </ActionIcon>
      </Group>

      {cards.length === 0 ? (
        <Text size="sm" c="dimmed">
          No cards yet
        </Text>
      ) : (
        // Tabs.List orientation is inherited from the parent <Tabs orientation="vertical">.
        // No explicit orientation prop is needed here.
        <Tabs.List>
          {cards.map((card) => (
            <Tabs.Tab key={card.id} value={card.id}>
              <SessionCard cardId={card.id} onRemove={onRemoveCard} />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      )}
    </>
  );
}
