import type React from "react";
import { ActionIcon, Group, Tabs, Text, Title } from "@mantine/core";
import type { Card } from "../../types/card";

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
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm">Card {card.id.slice(0, 8)}</Text>
                {/* component="div" avoids nesting <button> inside <button>
                    (Tabs.Tab renders as <button>; CloseButton also renders as
                    <button> by default, which is invalid HTML). Using a div
                    with role="button" keeps the accessible name and click
                    behaviour while producing valid HTML. */}
                <ActionIcon
                  component="div"
                  role="button"
                  aria-label={`Remove card ${card.id.slice(0, 8)}`}
                  variant="subtle"
                  size="xs"
                  tabIndex={0}
                  onClick={(event: React.MouseEvent) => {
                    // Stop the click from bubbling to the Tabs.Tab, which would
                    // briefly activate the deleted tab before the card is removed.
                    event.stopPropagation();
                    onRemoveCard(card.id);
                  }}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onRemoveCard(card.id);
                    }
                  }}
                >
                  ×
                </ActionIcon>
              </Group>
            </Tabs.Tab>
          ))}
        </Tabs.List>
      )}
    </>
  );
}
