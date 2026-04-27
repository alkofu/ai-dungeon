import { ActionIcon, Group, Tabs, Text, Title } from "@mantine/core";
import type { Card } from "../../types/card";
import type { ClaudeContext, ShellContext } from "../../types/session";
import { SessionCard } from "./SessionCard";

interface NavBarProps {
  cards: Card[];
  onAddCard: () => void;
  onRemoveCard: (id: string) => void;
  claudeContext: Record<string, ClaudeContext>;
  shellContext: Record<string, ShellContext>;
}

export function NavBar({
  cards,
  onAddCard,
  onRemoveCard,
  claudeContext,
  shellContext,
}: NavBarProps) {
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
            // Mantine's `Tabs.Tab` button defaults to `display: flex; align-items: center;
            // white-space: nowrap` with no width constraint, so it sizes to the intrinsic
            // width of its children and overflows the 250 px navbar (verified at
            // node_modules/@mantine/core/styles.css:7506-7516). The inner tabLabel span
            // additionally carries `flex: 1; text-align: center` (styles.css:7541-7544),
            // which would centre SessionCard content and defeat truncate. The props
            // below override both layers:
            //   w="100%"          - constrain outer button to navbar content width
            //   style.overflow    - clip children that exceed the constrained width
            //   style.whiteSpace  - allow the multi-row SessionCard Stack to wrap
            //   style.display     - block layout makes the width constraint predictable
            //                       (and renders the inner span's inherited `flex: 1` inert)
            //   styles.tabLabel   - reset inner span: full width, left-aligned, wrappable
            <Tabs.Tab
              key={card.id}
              value={card.id}
              w="100%"
              style={{ overflow: "hidden", whiteSpace: "normal", display: "block" }}
              styles={{ tabLabel: { width: "100%", textAlign: "left", whiteSpace: "normal" } }}
            >
              <SessionCard
                cardId={card.id}
                onRemove={onRemoveCard}
                claudeContext={claudeContext[card.id]}
                shellContext={shellContext[card.id]}
              />
            </Tabs.Tab>
          ))}
        </Tabs.List>
      )}
    </>
  );
}
