import { useCallback, useReducer } from "react";
import { AppLayout } from "./components/layout";
import type { Card, CardType } from "./types/card";
import type { SessionContext, ShellContext } from "./types/session";

// ── State shape ───────────────────────────────────────────────────────────────

export interface AppState {
  cards: Card[];
  activeId: string | null;
  sessionContext: Record<string, SessionContext>;
  shellContext: Record<string, ShellContext>;
  readyCardIds: Set<string>;
}

// ── Actions ───────────────────────────────────────────────────────────────────

type AppAction =
  | { type: "add"; cardType: CardType }
  | { type: "remove"; id: string }
  | { type: "activate"; id: string | null }
  | { type: "setSessionContext"; id: string; ctx: SessionContext }
  | { type: "setShellContext"; id: string; ctx: ShellContext }
  | { type: "markReady"; id: string };

// ── Reducer ───────────────────────────────────────────────────────────────────

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "add": {
      const newCard: Card = { id: globalThis.crypto.randomUUID(), type: action.cardType };
      return {
        // The new card is appended to the end of the list.
        cards: [...state.cards, newCard],
        // Always activate the newly added card — conventional UX for terminal apps.
        activeId: newCard.id,
        sessionContext: state.sessionContext,
        shellContext: state.shellContext,
        // The new card is not yet ready — readyCardIds is unchanged.
        readyCardIds: state.readyCardIds,
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
      const { [action.id]: _removed, ...remainingSessionContext } = state.sessionContext;
      void _removed;

      // Also remove the card's shell context.
      const { [action.id]: _removedShell, ...remainingShellContext } = state.shellContext;
      void _removedShell;

      // Also clear the removed card's ready state to avoid leaking across long sessions.
      const nextReady = new Set(state.readyCardIds);
      nextReady.delete(action.id);

      return {
        cards: remaining,
        activeId: nextActiveId,
        sessionContext: remainingSessionContext,
        shellContext: remainingShellContext,
        readyCardIds: nextReady,
      };
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
    case "setShellContext": {
      // No-op if the card is not in state.cards — guards against a race where
      // the OSC handler fires after the card is removed (before dispose).
      if (!state.cards.some((c) => c.id === action.id)) return state;
      return {
        ...state,
        shellContext: { ...state.shellContext, [action.id]: action.ctx },
      };
    }
    case "markReady": {
      // Idempotent: return same state reference when id is already present.
      if (state.readyCardIds.has(action.id)) return state;
      return { ...state, readyCardIds: new Set([...state.readyCardIds, action.id]) };
    }
    default:
      return state;
  }
}

const initialState: AppState = {
  cards: [],
  activeId: null,
  sessionContext: {},
  shellContext: {},
  readyCardIds: new Set(),
};

// ── Component ─────────────────────────────────────────────────────────────────

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);

  const addTerminalCard = useCallback(() => {
    dispatch({ type: "add", cardType: "terminal" });
  }, []);

  const addDungeonCard = useCallback(() => {
    dispatch({ type: "add", cardType: "dungeon" });
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

  const setShellContext = useCallback((id: string, ctx: ShellContext) => {
    dispatch({ type: "setShellContext", id, ctx });
  }, []);

  const markReady = useCallback((id: string) => {
    dispatch({ type: "markReady", id });
  }, []);

  return (
    <AppLayout
      cards={state.cards}
      activeId={state.activeId}
      onActiveIdChange={setActiveId}
      onAddTerminalCard={addTerminalCard}
      onAddDungeonCard={addDungeonCard}
      onRemoveCard={removeCard}
      sessionContext={state.sessionContext}
      onSessionContextChange={setSessionContext}
      shellContext={state.shellContext}
      onShellContextChange={setShellContext}
      readyCardIds={state.readyCardIds}
      onCardReady={markReady}
    />
  );
}
