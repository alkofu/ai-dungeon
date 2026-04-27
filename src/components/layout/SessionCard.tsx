import type React from "react";
import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconCircleDot, IconGitPullRequest } from "@tabler/icons-react";
import type { ClaudeContext, ShellContext } from "../../types/session";
import { getMockClaudeContext } from "./claudeContext.mock";

function isClaudeContext(m: ClaudeContext | ShellContext): m is ClaudeContext {
  return "slug" in m && typeof (m as ClaudeContext).slug === "string";
}

interface SessionCardProps {
  cardId: string;
  onRemove: (id: string) => void;
  /** OSC 6800 (Claude) context — authoritative when present. */
  claudeContext?: ClaudeContext;
  /** OSC 7/7337 (shell) context — used when no Claude context is present. */
  shellContext?: ShellContext;
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

export function SessionCard({ cardId, onRemove, claudeContext, shellContext }: SessionCardProps) {
  // Intentional: OSC 7337 clear does not erase branch/repo on a Claude-bound card.
  // ClaudeContext is authoritative over transient shell drift.
  const meta = claudeContext ?? shellContext ?? getMockClaudeContext(cardId);
  // prNumber and issueNumber only exist on ClaudeContext (Claude slot), not ShellContext.
  const prNumber = isClaudeContext(meta) ? meta.prNumber : undefined;
  const issueNumber = isClaudeContext(meta) ? meta.issueNumber : undefined;

  return (
    <Stack gap="xs">
      {/* Row 1: slug + close button */}
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={700}>
          {isClaudeContext(meta) ? meta.slug : "(shell)"}
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

      {/* Row 2: [repo : branch •] path-tail
          repo and branch are optional — cleared by empty OSC 7337.
          When absent, their segments (including the : and • separators) are omitted. */}
      <Group gap="xs" wrap="nowrap">
        {meta.repo != null && (
          <>
            <Tooltip label={`${meta.repo.owner}/${meta.repo.name}`} withinPortal={false}>
              <Text size="xs" c="dimmed" truncate>
                {meta.repo.name}
              </Text>
            </Tooltip>
            <Text size="xs" c="dimmed">
              :
            </Text>
          </>
        )}
        {meta.branch != null && (
          <>
            <Text size="xs" c="dimmed" truncate>
              {meta.branch}
            </Text>
            <Text size="xs" c="dimmed">
              •
            </Text>
          </>
        )}
        <Tooltip label={meta.workingDirectory} withinPortal={false}>
          <Text size="xs" c="dimmed" truncate>
            {lastSegments(meta.workingDirectory)}
          </Text>
        </Tooltip>
      </Group>

      {/* Row 3: PR badge, Issue badge, placeholder badge */}
      <Group gap="xs" wrap="nowrap">
        <Badge
          size="xs"
          variant="light"
          leftSection={<IconGitPullRequest size="1em" role="img" aria-label="Pull request" />}
        >
          {prNumber ? `PR #${prNumber}` : "PR —"}
        </Badge>
        <Badge
          size="xs"
          variant="light"
          leftSection={<IconCircleDot size="1em" role="img" aria-label="Issue" />}
        >
          {issueNumber ? `#${issueNumber}` : "Issue —"}
        </Badge>
        {/* No leftSection: placeholder badge intentionally renders no icon. */}
        <Badge size="xs" variant="light">
          —
        </Badge>
      </Group>
    </Stack>
  );
}
