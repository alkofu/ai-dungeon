import { useCallback, useState } from "react";
import { AppLayout } from "./components/layout";
import type { Card } from "./types/card";

function App() {
  const [cards, setCards] = useState<Card[]>([]);

  const addCard = useCallback(() => {
    setCards((prev) => [...prev, { id: globalThis.crypto.randomUUID() }]);
  }, []);

  const removeCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  }, []);

  return (
    <AppLayout cards={cards} onAddCard={addCard} onRemoveCard={removeCard}>
      <h1>AI Dungeon</h1>
      <p>Multi-workspace terminal for AI agents and CLIs.</p>
    </AppLayout>
  );
}

export default App;
