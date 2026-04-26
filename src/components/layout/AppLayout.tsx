import { AppShell, Burger, Group, Tabs, Text, Title } from "@mantine/core";
import { useDisclosure, useHotkeys } from "@mantine/hooks";
import { getCycleTargetId, getNumericTargetId } from "./tabNavigation";
import type { Card } from "../../types/card";
import type { SessionContext } from "../../types/session";
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
  sessionContext: Record<string, SessionContext>;
  onSessionContextChange: (id: string, ctx: SessionContext) => void;
  onSessionContextPatch: (id: string, patch: Partial<SessionContext>) => void;
}

export function AppLayout({
  cards,
  onAddCard,
  onRemoveCard,
  activeId,
  onActiveIdChange,
  sessionContext,
  onSessionContextChange,
  onSessionContextPatch,
}: AppLayoutProps) {
  const [opened, { toggle }] = useDisclosure(true);

  const activate = (targetId: string | null) => {
    if (targetId !== null) {
      onActiveIdChange(targetId);
    }
  };

  // useHotkeys registers a single document-level listener via
  // useEffect(..., []) and uses useEffectEvent to keep the hotkeys array
  // current — no per-render rebind occurs. The listener attaches at
  // document.documentElement (not window/document).
  //
  // The second positional argument (tagsToIgnore) is explicitly set to []
  // (overriding Mantine's default of ["INPUT","TEXTAREA","SELECT"]).
  // Mantine's internal shouldFireEvent gates on event.target.tagName and
  // would otherwise short-circuit when focus is in xterm's
  // xterm-helper-textarea (the hidden HTMLTextAreaElement xterm focuses
  // whenever the user clicks into the terminal viewport), silently
  // breaking the central use case ("hotkeys work when focus is in the
  // terminal"). These eleven combos are global app-navigation shortcuts,
  // not text-entry combos — Cmd+ArrowLeft/Right and Cmd+1..Cmd+9 do not
  // collide with any standard typing flow, so blocking them in inputs
  // would surprise users.
  //
  // Note on event.preventDefault(): Mantine's useHotkeys unconditionally
  // calls event.preventDefault() on every matched hotkey, regardless of
  // whether the handler does anything observable. This means even when
  // getCycleTargetId returns null (e.g. cards.length < 2, or activeId
  // not in cards) and `activate` is a no-op, Cmd+ArrowLeft's default
  // WebView back-navigation is still suppressed. This is intentional:
  // we never want Cmd+ArrowLeft to trigger WebView history navigation
  // inside the shell, so suppressing the default in the no-op case is
  // the correct behaviour, not a leak.
  useHotkeys(
    [
      ["mod+ArrowLeft", () => activate(getCycleTargetId(cards, activeId, -1))],
      ["mod+ArrowRight", () => activate(getCycleTargetId(cards, activeId, +1))],
      ["mod+1", () => activate(getNumericTargetId(cards, 1))],
      ["mod+2", () => activate(getNumericTargetId(cards, 2))],
      ["mod+3", () => activate(getNumericTargetId(cards, 3))],
      ["mod+4", () => activate(getNumericTargetId(cards, 4))],
      ["mod+5", () => activate(getNumericTargetId(cards, 5))],
      ["mod+6", () => activate(getNumericTargetId(cards, 6))],
      ["mod+7", () => activate(getNumericTargetId(cards, 7))],
      ["mod+8", () => activate(getNumericTargetId(cards, 8))],
      ["mod+9", () => activate(getNumericTargetId(cards, 9))],
    ],
    [],
  );

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
          <NavBar
            cards={cards}
            onAddCard={onAddCard}
            onRemoveCard={onRemoveCard}
            sessionContext={sessionContext}
          />
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
                <Terminal
                  sessionId={card.id}
                  onSessionContextChange={(ctx) => onSessionContextChange(card.id, ctx)}
                  onSessionContextPatch={(patch) => onSessionContextPatch(card.id, patch)}
                />
              </Tabs.Panel>
            ))
          )}
        </AppShell.Main>
      </AppShell>
    </Tabs>
  );
}
