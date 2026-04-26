import { useCallback, useReducer } from "react";
import { AppLayout } from "./components/layout";
import type { Card } from "./types/card";
import type { SessionContext } from "./types/session";

// ── State shape ───────────────────────────────────────────────────────────────

export interface AppState {
  cards: Card[];
  activeId: string | null;
  sessionContext: Record<string, SessionContext>;
}

// ── Actions ───────────────────────────────────────────────────────────────────

type AppAction =
  | { type: "add" }
  | { type: "remove"; id: string }
  | { type: "activate"; id: string | null }
  | { type: "setSessionContext"; id: string; ctx: SessionContext }
  | { type: "patchSessionContext"; id: string; patch: Partial<SessionContext> };

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
        sessionContext: state.sessionContext,
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

      // Remove the card's session context to avoid leaking memory across long sessions.
      // Use object destructuring rather than `delete` to keep the reducer pure.
      const { [action.id]: _removed, ...remainingContext } = state.sessionContext;
      void _removed;

      return { cards: remaining, activeId: nextActiveId, sessionContext: remainingContext };
    }
    case "activate": {
      if (action.id === null && state.cards.length > 0) {
        return state; // ignore null while cards exist
      }
      return { ...state, activeId: action.id };
    }
    case "setSessionContext": {
      // No-op if the card is not in state.cards — guards against a race where
      // the OSC handler fires after the card is removed (before dispose).
      if (!state.cards.some((c) => c.id === action.id)) return state;
      return {
        ...state,
        sessionContext: { ...state.sessionContext, [action.id]: action.ctx },
      };
    }
    case "patchSessionContext": {
      // No-op if the card is not in state.cards — parity with setSessionContext.
      if (!state.cards.some((c) => c.id === action.id)) return state;
      // No-op if no record exists to patch — OSC 6800 must initialise the record first.
      // OSC 7 / OSC 7337 patches against a missing record are silently dropped.
      if (state.sessionContext[action.id] === undefined) {
        if (import.meta.env.DEV) {
          console.debug("[osc-7|7337] patch dropped — no SessionContext record for card", {
            id: action.id,
          });
        }
        return state;
      }
      return {
        ...state,
        sessionContext: {
          ...state.sessionContext,
          [action.id]: { ...state.sessionContext[action.id], ...action.patch },
        },
      };
    }
    default:
      return state;
  }
}

const initialState: AppState = { cards: [], activeId: null, sessionContext: {} };

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

  const setSessionContext = useCallback((id: string, ctx: SessionContext) => {
    dispatch({ type: "setSessionContext", id, ctx });
  }, []);

  const setSessionContextPatch = useCallback((id: string, patch: Partial<SessionContext>) => {
    dispatch({ type: "patchSessionContext", id, patch });
  }, []);

  return (
    <AppLayout
      cards={state.cards}
      activeId={state.activeId}
      onActiveIdChange={setActiveId}
      onAddCard={addCard}
      onRemoveCard={removeCard}
      sessionContext={state.sessionContext}
      onSessionContextChange={setSessionContext}
      onSessionContextPatch={setSessionContextPatch}
    />
  );
}
