import {
  ActionIcon,
  Card as MantineCard,
  CloseButton,
  Group,
  Stack,
  Text,
  Title,
} from "@mantine/core";
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
        <Stack gap="xs">
          {cards.map((card) => (
            <MantineCard key={card.id}>
              <Group justify="space-between">
                <Text>Card {card.id.slice(0, 8)}</Text>
                {/* TODO: switch to card.title once Card gains a human-readable title field */}
                <CloseButton
                  aria-label={`Remove card ${card.id}`}
                  onClick={() => onRemoveCard(card.id)}
                />
              </Group>
            </MantineCard>
          ))}
        </Stack>
      )}
    </>
  );
}
