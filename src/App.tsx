import { useCallback, useReducer } from "react";
import { AppLayout } from "./components/layout";
import type { Card } from "./types/card";
import type { SessionContext } from "./components/Terminal/Terminal";

// Re-export SessionContext from Terminal so consumers can import it from App
// without creating a circular dependency chain.
export type { SessionContext };

// ── State shape ───────────────────────────────────────────────────────────────

export interface AppState {
  cards: Card[];
  activeId: string | null;
  // Per-session CWD and git context, keyed by card/session id.
  // Kept as a sibling map (not embedded in Card) so the Card interface stays unchanged.
  contexts: Record<string, SessionContext>;
}

// ── Actions ───────────────────────────────────────────────────────────────────

type AppAction =
  | { type: "add" }
  | { type: "remove"; id: string }
  | { type: "activate"; id: string | null }
  | { type: "setContext"; id: string; ctx: SessionContext };

// ── Reducer ───────────────────────────────────────────────────────────────────

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "add": {
      const newCard: Card = { id: globalThis.crypto.randomUUID() };
      return {
        // The new card is appended to the end of the list.
        cards: [...state.cards, newCard],
        // Always activate the newly added card — conventional UX for terminal apps.
        activeId: newCard.id,
        // Seed an empty context for the new session.
        contexts: { ...state.contexts, [newCard.id]: { cwd: null, git: null } },
      };
    }
    case "remove": {
      const remaining = state.cards.filter((c) => c.id !== action.id);
      let nextActiveId = state.activeId;

      if (state.activeId === action.id) {
        // Active card is being removed. Move to the previous card in the list,
        // falling back to the new first card if the removed card was the first,
        // or to null when no cards remain.
        if (remaining.length === 0) {
          nextActiveId = null;
        } else {
          const removedIndex = state.cards.findIndex((c) => c.id === action.id);
          // Previous card: index - 1, clamped to 0 (the new first card) when
          // the removed card was at index 0.
          const prevIndex = Math.max(0, removedIndex - 1);
          nextActiveId = remaining[prevIndex]?.id ?? null;
        }
      }

      // Remove the context entry to prevent the map from growing unboundedly.
      const { [action.id]: _removed, ...remainingContexts } = state.contexts;
      return { cards: remaining, activeId: nextActiveId, contexts: remainingContexts };
    }
    case "activate": {
      if (action.id === null && state.cards.length > 0) {
        return state; // ignore null while cards exist
      }
      return { ...state, activeId: action.id };
    }
    case "setContext": {
      // If the session no longer exists (stale OSC after card removal), no-op.
      if (!(action.id in state.contexts)) {
        return state;
      }
      return { ...state, contexts: { ...state.contexts, [action.id]: action.ctx } };
    }
    default:
      return state;
  }
}

const initialState: AppState = { cards: [], activeId: null, contexts: {} };

// ── Component ─────────────────────────────────────────────────────────────────

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const addCard = useCallback(() => {
    dispatch({ type: "add" });
  }, []);

  const removeCard = useCallback((id: string) => {
    dispatch({ type: "remove", id });
  }, []);

  // Mantine Tabs calls onChange with string | null; thread that through so the
  // user can switch tabs by clicking them.
  const setActiveId = useCallback((value: string | null) => {
    dispatch({ type: "activate", id: value });
  }, []);

  const setContext = useCallback((id: string, ctx: SessionContext) => {
    dispatch({ type: "setContext", id, ctx });
  }, []);

  return (
    <AppLayout
      cards={state.cards}
      activeId={state.activeId}
      onActiveIdChange={setActiveId}
      onAddCard={addCard}
      onRemoveCard={removeCard}
      contexts={state.contexts}
      onContextChange={setContext}
    />
  );
}
