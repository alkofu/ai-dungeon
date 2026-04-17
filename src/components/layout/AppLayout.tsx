import { AppShell, Burger, Group, Title } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import type { ReactNode } from "react";
import type { Card } from "../../types/card";
import { NavBar } from "./NavBar";

// cards props are required; only consumer is App.tsx (YAGNI — make optional if a second consumer is added)
interface AppLayoutProps {
  children: ReactNode;
  cards: Card[];
  onAddCard: () => void;
  onRemoveCard: (id: string) => void;
}

export function AppLayout({ children, cards, onAddCard, onRemoveCard }: AppLayoutProps) {
  const [opened, { toggle }] = useDisclosure(true);

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{
        width: 250,
        breakpoint: 0,
        collapsed: { desktop: !opened },
      }}
      padding="md"
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

      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
