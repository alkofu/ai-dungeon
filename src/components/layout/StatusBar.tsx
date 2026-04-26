import { Group, Text } from "@mantine/core";
import type { SessionContext } from "../Terminal/Terminal";

interface StatusBarProps {
  context: SessionContext;
}

// Note: CWD is rendered verbatim from the OSC 7 payload. The shell-side script
// emits the raw $PWD value (e.g. /Users/me/projects/foo). Client-side $HOME
// collapse (to ~) is deferred: the frontend has no reliable way to know the
// user's home directory without a new IPC call. A future contributor should
// emit the collapsed path from the shell init script instead.
export function StatusBar({ context }: StatusBarProps) {
  return (
    <Group
      data-testid="status-bar"
      justify="space-between"
      h={24}
      px="xs"
      style={{ borderTop: "1px solid var(--mantine-color-dark-4, #373A40)", flexShrink: 0 }}
    >
      <Text data-testid="status-bar-cwd" size="xs" c={context.cwd === null ? "dimmed" : undefined}>
        {context.cwd ?? "…"}
      </Text>
      {context.git !== null && (
        <Text data-testid="status-bar-git" size="xs">
          {context.git.repo} · {context.git.branch}
        </Text>
      )}
    </Group>
  );
}
