import { ActionIcon, Group, Menu, Tabs, Text, Title } from "@mantine/core";
import type { Card } from "../../types/card";
import type { SessionContext, ShellContext } from "../../types/session";
import { SessionCard } from "./SessionCard";

interface NavBarProps {
  cards: Card[];
  onAddTerminalCard: () => void;
  onAddDungeonCard: () => void;
  onRemoveCard: (id: string) => void;
  sessionContext: Record<string, SessionContext>;
  shellContext: Record<string, ShellContext>;
  /** When true, each card renders a shortcut hint overlay (⌘N / Ctrl+N). Optional so existing tests that omit it remain valid. */
  modifierPressed?: boolean;
}

export function NavBar({
  cards,
  onAddTerminalCard,
  onAddDungeonCard,
  onRemoveCard,
  sessionContext,
  shellContext,
  modifierPressed = false,
}: NavBarProps) {
  return (
    <>
      <Group justify="space-between">
        <Title order={5}>Cards</Title>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon aria-label="Add card menu" variant="default">
              +
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={onAddTerminalCard}>Terminal</Menu.Item>
            <Menu.Item onClick={onAddDungeonCard}>Dungeon</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      {cards.length === 0 ? (
        <Text size="sm" c="dimmed">
          No cards yet
        </Text>
      ) : (
        // Tabs.List orientation is inherited from the parent <Tabs orientation="vertical">.
        // No explicit orientation prop is needed here.
        <Tabs.List>
          {cards.map((card, index) => {
            const position = index + 1;
            return (
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
                  sessionContext={sessionContext[card.id]}
                  shellContext={shellContext[card.id]}
                  modifierPressed={modifierPressed}
                  position={position}
                />
              </Tabs.Tab>
            );
          })}
        </Tabs.List>
      )}
    </>
  );
}
