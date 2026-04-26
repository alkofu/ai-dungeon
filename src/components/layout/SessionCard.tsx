import type React from "react";
import { ActionIcon, Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { getMockSessionMeta } from "./sessionMeta.mock";

interface SessionCardProps {
  cardId: string;
  onRemove: (id: string) => void;
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

export function SessionCard({ cardId, onRemove }: SessionCardProps) {
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

      {/* Row 2: repo : branch • path-tail */}
      <Group gap="xs" wrap="nowrap">
        <Tooltip label={`${meta.repo.owner}/${meta.repo.name}`} withinPortal={false}>
          <Text size="xs" c="dimmed" truncate>
            {meta.repo.name}
          </Text>
        </Tooltip>
        <Text size="xs" c="dimmed">
          :
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {meta.branch}
        </Text>
        <Text size="xs" c="dimmed">
          •
        </Text>
        <Tooltip label={meta.workingDirectory} withinPortal={false}>
          <Text size="xs" c="dimmed" truncate>
            {lastSegments(meta.workingDirectory)}
          </Text>
        </Tooltip>
      </Group>

      {/* Row 3: PR badge, Issue badge, placeholder badge */}
      <Group gap="xs" wrap="nowrap">
        <Badge size="xs" variant="light">
          {meta.prNumber ? `PR #${meta.prNumber}` : "PR —"}
        </Badge>
        <Badge size="xs" variant="light">
          {meta.issueNumber ? `#${meta.issueNumber}` : "Issue —"}
        </Badge>
        <Badge size="xs" variant="light">
          —
        </Badge>
      </Group>
    </Stack>
  );
}
