import type React from "react";
import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconCircleDot, IconGitPullRequest } from "@tabler/icons-react";
import type { SessionContext } from "../Terminal/Terminal";
import { getMockSessionMeta } from "./sessionMeta.mock";

interface SessionCardProps {
  cardId: string;
  onRemove: (id: string) => void;
  context: SessionContext;
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

export function SessionCard({ cardId, onRemove, context }: SessionCardProps) {
  const meta = getMockSessionMeta(cardId);

  return (
    <Stack gap="xs">
      {/* Row 1: slug + close button */}
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={700}>
          {meta.slug}
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

      {/* Row 2: repo : branch • path-tail  (git present)
               OR  path-tail right-aligned   (no git)
          Note: justify="flex-end" for the git-null case is a visual concern.
          Mantine's Group renders inline styles in jsdom but computed layout is
          not meaningful without a real browser — automated assertion for right-
          alignment is omitted; manual verification covers this (Step 6). */}
      {context.git !== null ? (
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed" truncate>
            {context.git.repo}
          </Text>
          <Text size="xs" c="dimmed">
            :
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {context.git.branch}
          </Text>
          <Text size="xs" c="dimmed">
            •
          </Text>
          <Tooltip label={context.cwd ?? ""} withinPortal={false}>
            <Text size="xs" c="dimmed" truncate>
              {context.cwd !== null ? lastSegments(context.cwd) : "…"}
            </Text>
          </Tooltip>
        </Group>
      ) : (
        <Group justify="flex-end" wrap="nowrap">
          <Tooltip label={context.cwd ?? ""} withinPortal={false}>
            <Text size="xs" c="dimmed" truncate>
              {context.cwd !== null ? lastSegments(context.cwd) : "…"}
            </Text>
          </Tooltip>
        </Group>
      )}

      {/* Row 3: PR badge, Issue badge, placeholder badge */}
      <Group gap="xs" wrap="nowrap">
        <Badge
          size="xs"
          variant="light"
          leftSection={<IconGitPullRequest size="1em" role="img" aria-label="Pull request" />}
        >
          {meta.prNumber ? `PR #${meta.prNumber}` : "PR —"}
        </Badge>
        <Badge
          size="xs"
          variant="light"
          leftSection={<IconCircleDot size="1em" role="img" aria-label="Issue" />}
        >
          {meta.issueNumber ? `#${meta.issueNumber}` : "Issue —"}
        </Badge>
        {/* No leftSection: placeholder badge intentionally renders no icon. */}
        <Badge size="xs" variant="light">
          —
        </Badge>
      </Group>
    </Stack>
  );
}
