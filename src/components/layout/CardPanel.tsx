import { Tabs } from "@mantine/core";
import type { Card } from "../../types/card";
import type { SessionContext, ShellContext } from "../../types/session";
import { Terminal } from "../Terminal";
import { useDungeonSidecar } from "../Terminal/useDungeonSidecar";

interface CardPanelProps {
  card: Card;
  onSessionContextChange: (ctx: SessionContext) => void;
  onShellContextChange: (ctx: ShellContext) => void;
}

export function CardPanel({ card, onSessionContextChange, onShellContextChange }: CardPanelProps) {
  useDungeonSidecar(card);

  return (
    // flex: 1, minHeight: 0 rather than height: 100% because AppShell.Main
    // is already a flex column — flex children need flex: 1 to fill the
    // available space, whereas height: 100% does not resolve reliably
    // against a flex-column parent without an explicit definite height.
    <Tabs.Panel key={card.id} value={card.id} style={{ flex: 1, minHeight: 0 }}>
      <Terminal
        sessionId={card.id}
        onSessionContextChange={onSessionContextChange}
        onShellContextChange={onShellContextChange}
      />
    </Tabs.Panel>
  );
}
