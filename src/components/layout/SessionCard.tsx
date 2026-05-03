import type React from "react";
import { ActionIcon, Badge, Box, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconCircleDot, IconGitPullRequest } from "@tabler/icons-react";
import type { SessionContext, ShellContext } from "../../types/session";
import { getMockSessionContext } from "./sessionContext.mock";
import { isMacPlatform } from "./useModifierHeld";

// Deliberate formatting asymmetry: ⌘ has no + separator (self-contained glyph per macOS HIG);
// Ctrl+ includes the + per Windows/Linux convention. Labels become ⌘1 and Ctrl+1.
const SHORTCUT_GLYPH = isMacPlatform() ? "⌘" : "Ctrl+";

function isSessionContext(m: SessionContext | ShellContext): m is SessionContext {
  return "slug" in m && typeof (m as SessionContext).slug === "string";
}

interface SessionCardProps {
  cardId: string;
  onRemove: (id: string) => void;
  /** OSC 6800 session context — authoritative when present. */
  sessionContext?: SessionContext;
  /** OSC 7/7337 (shell) context — used when no session context is present. */
  shellContext?: ShellContext;
  /** When true, shows a keyboard-shortcut overlay label (⌘N / Ctrl+N). Optional; defaults to false. */
  modifierPressed?: boolean;
  /** 1-based position of this card in the NavBar cards array. Overlay is only shown for positions 1–9. */
  position?: number;
  /** When true, applies the active visual treatment — dark background and bold typography. Defaults to false. */
  active?: boolean;
  /** Optional status subtitle rendered below the slug. When undefined the line is omitted entirely. */
  status?: string;
}

/**
 * Returns the last 1-2 path segments of a POSIX path (forward-slash only).
 * Trailing slashes are stripped before splitting.
 */
function lastSegments(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join("/");
  }
  return parts[parts.length - 1] ?? "";
}

export function SessionCard({
  cardId,
  onRemove,
  sessionContext,
  shellContext,
  modifierPressed = false,
  position = undefined,
  active = false,
  status,
}: SessionCardProps) {
  // Intentional: OSC 7337 clear does not erase branch/repo on a session-bound card.
  // SessionContext is authoritative over transient shell drift.
  const meta = sessionContext ?? shellContext ?? getMockSessionContext(cardId);
  // prNumber and issueNumber only exist on SessionContext (OSC 6800 slot), not ShellContext.
  const prNumber = isSessionContext(meta) ? meta.prNumber : undefined;
  const issueNumber = isSessionContext(meta) ? meta.issueNumber : undefined;

  // Show the shortcut overlay only when modifier is held, position is valid (1–9).
  const showShortcut =
    modifierPressed === true && typeof position === "number" && position >= 1 && position <= 9;

  return (
    // Mantine Tooltip cloneElement-s the wrapped Stack to inject a ref and hover handlers
    // (onMouseEnter, onMouseLeave, onPointerDown, onPointerEnter). Because opened is
    // controlled, useDismiss is disabled and these injected handlers are inert — tooltip
    // visibility is driven solely by the opened prop.
    // withinPortal={true} (the Mantine default) makes the floating panel escape
    // Tabs.Tab's overflow:hidden clipping boundary set in NavBar.tsx.
    <Tooltip
      opened={showShortcut}
      label={`${SHORTCUT_GLYPH}${String(position)}`}
      position="right"
      withArrow
      withinPortal={true}
    >
      <Box
        bg={active ? "dark.7" : "transparent"}
        p="xs"
        style={{ borderRadius: "var(--mantine-radius-sm)" }}
        data-active={active ? "true" : "false"}
      >
        <Stack gap="xs">
          {/* Row 1: slug + close button */}
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" fw={active ? 700 : 500}>
              {isSessionContext(meta) ? meta.slug : "(shell)"}
            </Text>
            {/* component="div" avoids nesting <button> inside <button>
              (Tabs.Tab renders as <button>; ActionIcon renders as <button> by default,
              which is invalid HTML). Using a div with role="button" keeps the
              accessible name and click behaviour while producing valid HTML. */}
            <ActionIcon
              component="div"
              role="button"
              aria-label={`Remove card ${cardId.slice(0, 8)}`}
              variant="subtle"
              size="xs"
              tabIndex={0}
              onClick={(event: React.MouseEvent) => {
                event.stopPropagation();
                onRemove(cardId);
              }}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRemove(cardId);
                }
              }}
            >
              ×
            </ActionIcon>
          </Group>

          {status != null && (
            <Text size="xs" c={active ? "gray.4" : "dimmed"}>
              {status}
            </Text>
          )}

          {/* Row 2: [repo : branch •] path-tail
            repo and branch are optional — cleared by empty OSC 7337.
            When absent, their segments (including the : and • separators) are omitted. */}
          <Group gap="xs" wrap="nowrap">
            {meta.repo != null && (
              <>
                <Tooltip label={`${meta.repo.owner}/${meta.repo.name}`} withinPortal={false}>
                  <Text size="xs" c={active ? "white" : "dimmed"} truncate>
                    {meta.repo.name}
                  </Text>
                </Tooltip>
                <Text size="xs" c={active ? "white" : "dimmed"}>
                  :
                </Text>
              </>
            )}
            {meta.branch != null && (
              <>
                <Text size="xs" c={active ? "white" : "dimmed"} truncate>
                  {meta.branch}
                </Text>
                <Text size="xs" c={active ? "white" : "dimmed"}>
                  •
                </Text>
              </>
            )}
            <Tooltip label={meta.workingDirectory} withinPortal={false}>
              <Text size="xs" c={active ? "white" : "dimmed"} truncate>
                {lastSegments(meta.workingDirectory)}
              </Text>
            </Tooltip>
          </Group>

          {/* Row 3: optional PR badge, optional Issue badge, placeholder badge */}
          <Box
            style={{
              borderTop: "1px solid var(--mantine-color-default-border)",
              paddingTop: "var(--mantine-spacing-xs)",
            }}
          />
          <Group gap="xs" wrap="nowrap" opacity={0.6}>
            {prNumber != null && (
              <Badge
                size="xs"
                variant="light"
                leftSection={<IconGitPullRequest size="1em" role="img" aria-label="Pull request" />}
              >
                {`PR #${prNumber}`}
              </Badge>
            )}
            {issueNumber != null && (
              <Badge
                size="xs"
                variant="light"
                leftSection={<IconCircleDot size="1em" role="img" aria-label="Issue" />}
              >
                {`#${issueNumber}`}
              </Badge>
            )}
            {/* No leftSection: placeholder badge intentionally renders no icon. */}
            <Badge size="xs" variant="light">
              —
            </Badge>
          </Group>
        </Stack>
      </Box>
    </Tooltip>
  );
}
