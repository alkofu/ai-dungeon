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
  /** @deprecated this prop is no longer consumed; the shortcut chip is now persistent. Scheduled for removal once NavBar/AppLayout plumbing is also cleaned up in a follow-up PR. */
  modifierPressed?: boolean;
  /** 1-based position of this card in the NavBar cards array. Shortcut chip is shown for positions 1–9. */
  position?: number;
  /** When true, applies the active visual treatment — dark background and bold typography. Defaults to false. */
  active?: boolean;
  /** Optional status subtitle rendered below the slug. When undefined the line is omitted entirely. */
  status?: string;
  /** When true, renders the NEEDS REVIEW label and orange accent. Explicit prop wins; otherwise derived from sessionContext.needsReview. */
  needsReview?: boolean;
}

export function SessionCard({
  cardId,
  onRemove,
  sessionContext,
  shellContext,
  position = undefined,
  active = false,
  status,
  needsReview: needsReviewProp,
}: SessionCardProps) {
  // Intentional: OSC 7337 clear does not erase branch/repo on a session-bound card.
  // SessionContext is authoritative over transient shell drift.
  const meta = sessionContext ?? shellContext ?? getMockSessionContext(cardId);
  // prNumber and issueNumber only exist on SessionContext (OSC 6800 slot), not ShellContext.
  const prNumber = isSessionContext(meta) ? meta.prNumber : undefined;
  const issueNumber = isSessionContext(meta) ? meta.issueNumber : undefined;

  // Explicit prop wins; otherwise derive from sessionContext when available.
  const needsReview =
    needsReviewProp !== undefined
      ? needsReviewProp
      : isSessionContext(meta)
        ? (meta.needsReview ?? false)
        : false;

  const slug = isSessionContext(meta) ? meta.slug : "(shell)";

  // Subtitle: "repo • branch" with no separator when one segment is absent.
  const subtitleParts = [meta.repo?.name, meta.branch].filter(Boolean);

  const hasBadges = prNumber != null || issueNumber != null;

  return (
    <Box
      data-active={active ? "true" : "false"}
      data-needs-review={needsReview ? "true" : "false"}
      style={{
        borderLeft: `4px solid ${needsReview ? "var(--mantine-color-orange-6)" : "var(--mantine-color-blue-5)"}`,
        borderRadius: "var(--mantine-radius-md)",
        padding: "var(--mantine-spacing-md)",
        backgroundColor: active ? "var(--mantine-color-blue-9)" : "var(--mantine-color-dark-7)",
      }}
    >
      <Stack gap="xs">
        {/* NEEDS REVIEW label */}
        {needsReview && (
          <Group gap={6} align="center">
            <Box w={6} h={6} bg="orange.6" style={{ borderRadius: "50%" }} />
            <Text size="xs" fw={700} c="orange.6" tt="uppercase" lts="0.05em">
              NEEDS REVIEW
            </Text>
          </Group>
        )}

        {/* Header row: title + shortcut chip + close button */}
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2}>
            <Text size="md" fw={700} c="white">
              {slug}
            </Text>
            {subtitleParts.length > 0 && (
              <Text size="xs" fs="italic" c="dimmed">
                {subtitleParts.map((part, i) => {
                  const isRepo = i === 0 && meta.repo != null && part === meta.repo.name;
                  const isBranch = part === meta.branch && meta.branch != null;

                  if (isRepo) {
                    return (
                      <span key="repo">
                        <Tooltip
                          label={`${meta.repo!.owner}/${meta.repo!.name}`}
                          withinPortal={false}
                        >
                          <span>{part}</span>
                        </Tooltip>
                        {subtitleParts.length > 1 ? " • " : ""}
                      </span>
                    );
                  }
                  if (isBranch && meta.workingDirectory) {
                    return (
                      <Tooltip key="branch" label={meta.workingDirectory} withinPortal={false}>
                        <span>{part}</span>
                      </Tooltip>
                    );
                  }
                  return <span key={`part-${String(i)}`}>{part}</span>;
                })}
              </Text>
            )}
            {status != null && (
              <Text size="xs" c="dimmed">
                {status}
              </Text>
            )}
          </Stack>
          <Group gap="xs">
            {/* Persistent shortcut chip for positions 1–9 */}
            {position != null && position >= 1 && position <= 9 && (
              <Box
                px={8}
                py={2}
                style={{
                  backgroundColor: "var(--mantine-color-gray-2)",
                  color: "var(--mantine-color-dark-9)",
                  borderRadius: "var(--mantine-radius-sm)",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 2,
                }}
              >
                {SHORTCUT_GLYPH}
                {String(position)}
              </Box>
            )}
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
        </Group>

        {/* Badge row: only when at least one of prNumber, issueNumber is defined */}
        {hasBadges && (
          <Group gap="xs" wrap="nowrap">
            {prNumber != null && (
              <Badge
                size="sm"
                variant="filled"
                color={needsReview ? "orange" : "blue"}
                radius="sm"
                leftSection={<IconGitPullRequest size={12} role="img" aria-label="Pull request" />}
              >
                {`#${prNumber}`}
              </Badge>
            )}
            {issueNumber != null && (
              <Badge
                size="sm"
                variant="filled"
                color={needsReview ? "orange" : "blue"}
                radius="sm"
                leftSection={<IconCircleDot size={12} role="img" aria-label="Issue" />}
              >
                {`#${issueNumber}`}
              </Badge>
            )}
          </Group>
        )}
      </Stack>
    </Box>
  );
}
