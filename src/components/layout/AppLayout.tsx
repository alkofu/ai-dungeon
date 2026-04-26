import { AppShell, Burger, Group, Tabs, Text, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { Card } from "../../types/card";
import { NavBar } from "./NavBar";
import { Terminal } from "../Terminal";

// Only consumer is App.tsx. `children` has been removed — AppLayout renders
// Tabs.Panel content (Terminal instances) directly so that Tabs.List (navbar)
// and Tabs.Panel (main) share the same Tabs context.
interface AppLayoutProps {
  cards: Card[];
  onAddCard: () => void;
  onRemoveCard: (id: string) => void;
  activeId: string | null;
  onActiveIdChange: (value: string | null) => void;
}

export function AppLayout({
  cards,
  onAddCard,
  onRemoveCard,
  activeId,
  onActiveIdChange,
}: AppLayoutProps) {
  const [opened, { toggle }] = useDisclosure(true);

  return (
    // Tabs wraps the entire AppShell so that Tabs.List (inside AppShell.Navbar)
    // and Tabs.Panel (inside AppShell.Main) share one React context.
    // keepMounted=true keeps inactive Tabs.Panel nodes in the DOM so PTY
    // sessions are not destroyed when the user switches tabs.
    // keepMountedMode="display-none" is required: the default 'activity' mode
    // uses React 19's Activity component, which suppresses effects in hidden
    // panels — that would prevent the Terminal useEffect from spawning a PTY
    // session until the panel is first activated. display-none hides the panel
    // purely via CSS while keeping all component effects running normally.
    <Tabs
      orientation="vertical"
      keepMounted={true}
      keepMountedMode="display-none"
      value={activeId}
      onChange={onActiveIdChange}
    >
      <AppShell
        header={{ height: 60 }}
        navbar={{
          width: 250,
          breakpoint: 0,
          collapsed: { desktop: !opened },
        }}
        padding="md"
        styles={{
          // <Tabs orientation="vertical"> renders as display:flex; flex-direction:row.
          // <AppShell> is the sole flex child of that row and would otherwise size
          // to its intrinsic content width. flex:1 makes it stretch to fill the row,
          // and minWidth:0 permits horizontal shrinkage so contents can flex correctly.
          root: { flex: 1, minWidth: 0 },
          main: {
            display: "flex",
            flexDirection: "column",
            height: "calc(100vh - var(--app-shell-header-height, 60px))",
            // Required so AppShell.Main can flex-shrink within the AppShell flex
            // column and not force the layout taller than the viewport. The
            // Terminal div inside also has minHeight: 0 for the same reason at
            // the next level of the flex chain — both are needed for height: 100%
            // on the Terminal container to resolve to a definite non-zero value.
            minHeight: 0,
          },
        }}
      >
        <AppShell.Header>
          <Group h="100%" px="md">
            <Burger opened={opened} onClick={toggle} size="sm" aria-label="Toggle navigation" />
            <Title order={3}>AI Dungeon</Title>
          </Group>
        </AppShell.Header>

        <AppShell.Navbar p="md">
          <NavBar cards={cards} onAddCard={onAddCard} onRemoveCard={onRemoveCard} />
        </AppShell.Navbar>

        <AppShell.Main>
          {cards.length === 0 ? (
            // Empty state: no cards, no terminals.
            <Text data-testid="main-empty-state" c="dimmed">
              No card selected. Click + in the sidebar to add one.
            </Text>
          ) : (
            cards.map((card) => (
              // flex: 1, minHeight: 0 rather than height: 100% because AppShell.Main
              // is already a flex column — flex children need flex: 1 to fill the
              // available space, whereas height: 100% does not resolve reliably
              // against a flex-column parent without an explicit definite height.
              <Tabs.Panel key={card.id} value={card.id} style={{ flex: 1, minHeight: 0 }}>
                <Terminal sessionId={card.id} />
              </Tabs.Panel>
            ))
          )}
        </AppShell.Main>
      </AppShell>
    </Tabs>
  );
}
