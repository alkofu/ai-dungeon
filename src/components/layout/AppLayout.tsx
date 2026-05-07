import React, { Suspense, useEffect, useState } from "react";
import {
  ActionIcon,
  AppShell,
  Box,
  Burger,
  Center,
  Group,
  Loader,
  Tabs,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure, useHotkeys } from "@mantine/hooks";
import { IconSettings } from "@tabler/icons-react";
import { getCycleTargetId, getNumericTargetId } from "./tabNavigation";
import { useModifierHeld } from "./useModifierHeld";
import type { Card } from "../../types/card";
import type { SessionContext, ShellContext } from "../../types/session";
import { NavBar } from "./NavBar";
import { NavbarResizer } from "./NavbarResizer";
import { useNavbarWidth } from "./useNavbarWidth";
import { Terminal } from "../Terminal";
import { SettingsModal } from "../settings";
import { DungeonPanel } from "./DungeonPanel";

// Shared loading indicator used by both loading gates (see two-gate comment below).
function TerminalLoadingContent() {
  return (
    <Group gap="xs">
      <Loader size="sm" />
      <Text size="sm" c="dimmed">
        loading…
      </Text>
    </Group>
  );
}

function assertNever(x: never): React.ReactNode {
  console.error(`Unexpected card type: ${String(x)}`);
  return <Text c="red">Unknown card type: {String(x)}</Text>;
}

// Only consumer is App.tsx. `children` has been removed — AppLayout renders
// Tabs.Panel content (Terminal instances) directly so that Tabs.List (navbar)
// and Tabs.Panel (main) share the same Tabs context.
interface AppLayoutProps {
  cards: Card[];
  onAddTerminalCard: () => void;
  onAddDungeonCard: () => void;
  onRemoveCard: (id: string) => void;
  activeId: string | null;
  onActiveIdChange: (value: string | null) => void;
  sessionContext: Record<string, SessionContext>;
  onSessionContextChange: (id: string, ctx: SessionContext) => void;
  shellContext: Record<string, ShellContext>;
  onShellContextChange: (id: string, ctx: ShellContext) => void;
  readyCardIds: Set<string>;
  onCardReady: (id: string) => void;
}

export function AppLayout({
  cards,
  onAddTerminalCard,
  onAddDungeonCard,
  onRemoveCard,
  activeId,
  onActiveIdChange,
  sessionContext,
  onSessionContextChange,
  shellContext,
  onShellContextChange,
  readyCardIds,
  onCardReady,
}: AppLayoutProps) {
  const [opened, { toggle }] = useDisclosure(true);
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const modifierPressed = useModifierHeld();

  const { width: persistedWidth, setWidth, MIN, MAX } = useNavbarWidth();
  const [liveWidth, setLiveWidth] = useState(persistedWidth);
  // Track whether a drag is in progress so the effect below does not snap the
  // width back to the persisted value while the user is still dragging (F-6).
  const draggingRef = React.useRef(false);
  // Sync liveWidth when persistedWidth changes (e.g. settings reloaded from disk),
  // but only when no drag is in progress.
  useEffect(() => {
    if (!draggingRef.current) {
      setLiveWidth(persistedWidth);
    }
  }, [persistedWidth]);

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
          width: liveWidth,
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
          <Group h="100%" px="md" justify="space-between">
            <Group>
              <Burger opened={opened} onClick={toggle} size="sm" aria-label="Toggle navigation" />
              <Title order={3}>AI Dungeon</Title>
            </Group>
            <ActionIcon variant="subtle" onClick={openSettings} aria-label="Open settings">
              <IconSettings size={20} />
            </ActionIcon>
          </Group>
        </AppShell.Header>

        {/*
         * p="md" is on the inner Box (not on AppShell.Navbar itself) so that
         * the absolutely-positioned NavbarResizer can be anchored to right:0
         * of the unpadded navbar element — which is exactly the sidebar/main
         * visual boundary. If p="md" were on AppShell.Navbar, the resizer
         * would sit ~16px inside the visual right edge (the padding-right).
         * AppShell.Navbar does not set overflow:hidden in Mantine v9, so the
         * absolutely-positioned resizer is not clipped.
         */}
        <AppShell.Navbar style={{ position: "relative" }}>
          <Box p="md" style={{ height: "100%", overflowY: "auto" }}>
            <NavBar
              cards={cards}
              onAddTerminalCard={onAddTerminalCard}
              onAddDungeonCard={onAddDungeonCard}
              onRemoveCard={onRemoveCard}
              sessionContext={sessionContext}
              shellContext={shellContext}
              modifierPressed={modifierPressed}
              activeId={activeId}
            />
          </Box>
          {/*
           * NavbarResizer is a sibling of the inner Box, positioned at right:0
           * of the unpadded AppShell.Navbar. visible=opened ensures the
           * handle is hidden and unfocusable when the sidebar is collapsed.
           * onWidthChange updates liveWidth at frame rate (no persistence).
           * onCommit calls setWidth which debounces persistence writes (F-1).
           * draggingRef prevents mid-drag snap-back (F-6).
           */}
          <NavbarResizer
            width={liveWidth}
            onWidthChange={(next) => {
              draggingRef.current = true;
              setLiveWidth(next);
            }}
            onCommit={(final) => {
              draggingRef.current = false;
              setWidth(final);
            }}
            min={MIN}
            max={MAX}
            visible={opened}
          />
        </AppShell.Navbar>

        <AppShell.Main>
          {cards.length === 0 ? (
            // Empty state: no cards, no terminals.
            <Text data-testid="main-empty-state" c="dimmed">
              No card selected. Click + in the sidebar to add a terminal or dungeon card.
            </Text>
          ) : (
            cards.map((card) => (
              // flex: 1, minHeight: 0 rather than height: 100% because AppShell.Main
              // is already a flex column — flex children need flex: 1 to fill the
              // available space, whereas height: 100% does not resolve reliably
              // against a flex-column parent without an explicit definite height.
              <Tabs.Panel key={card.id} value={card.id} style={{ flex: 1, minHeight: 0 }}>
                {card.type === "terminal" ? (
                  // Two gates: (1) Suspense covers lazy chunk fetch; (2) the ready-overlay
                  // below covers PTY spawn + flush. Both render the same visual to avoid a
                  // UI flicker on the handoff.
                  <Suspense
                    fallback={
                      <Center
                        data-testid="terminal-loading"
                        style={{ width: "100%", height: "100%" }}
                      >
                        <TerminalLoadingContent />
                      </Center>
                    }
                  >
                    <div style={{ position: "relative", width: "100%", height: "100%" }}>
                      {/* Inline closures are safe here — Terminal captures them via
                          onReadyRef / onSessionContextChangeRef / onShellContextChangeRef
                          and they are NOT in the spawn useEffect's deps.
                          See Terminal.tsx for the ref-capture invariant. */}
                      <Terminal
                        sessionId={card.id}
                        onSessionContextChange={(ctx) => onSessionContextChange(card.id, ctx)}
                        onShellContextChange={(ctx) => onShellContextChange(card.id, ctx)}
                        onReady={() => onCardReady(card.id)}
                      />
                      {/* The overlay is an absolutely-positioned sibling of <Terminal> and does NOT affect the terminal-root's measured dimensions. */}
                      {!readyCardIds.has(card.id) && (
                        <Center
                          data-testid="terminal-loading-overlay"
                          style={{
                            position: "absolute",
                            inset: 0,
                            backgroundColor: "var(--mantine-color-body)",
                          }}
                        >
                          <TerminalLoadingContent />
                        </Center>
                      )}
                    </div>
                  </Suspense>
                ) : card.type === "dungeon" ? (
                  <DungeonPanel card={card} />
                ) : (
                  assertNever(card.type)
                )}
              </Tabs.Panel>
            ))
          )}
        </AppShell.Main>
      </AppShell>
      <SettingsModal opened={settingsOpened} onClose={closeSettings} />
    </Tabs>
  );
}
