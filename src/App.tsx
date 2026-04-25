import { useCallback, useState } from "react";
import { Terminal } from "./components/Terminal";
import { AppLayout } from "./components/layout";
import type { Card } from "./types/card";

export function App() {
  const [cards, setCards] = useState<Card[]>([]);

  const addCard = useCallback(() => {
    setCards((prev) => [...prev, { id: globalThis.crypto.randomUUID() }]);
  }, []);

  const removeCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return (
    <AppLayout cards={cards} onAddCard={addCard} onRemoveCard={removeCard}>
      <Terminal />
    </AppLayout>
  );
}
