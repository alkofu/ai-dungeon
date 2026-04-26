# Project Structure

```
ai-dungeon/
├── src/              # React + TypeScript frontend
│   ├── main.tsx      # Entry point — mounts MantineProvider, imports xterm CSS
│   ├── App.tsx       # Root component — useReducer for cards + activeId; owns tab state
│   ├── types/
│   │   ├── card.ts               # Card type ({ id: string })
│   │   ├── session.ts            # SessionContext interface — fields sourced from OSC 6800 (full) and OSC 7 / OSC 7337 (partial merges); all values are UNTRUSTED. branch and repo are optional (cleared by empty OSC 7337).
│   │   ├── sessionPayload.ts     # parseSessionContextPayload() / parseOsc7Payload() / parseOsc7337Payload() — validate all inbound OSC payloads before they enter app state. Single audit entry point for OSC 6800, OSC 7, and OSC 7337.
│   │   └── sessionPayload.test.ts
│   └── components/
│       ├── Terminal/
│       │   ├── Terminal.tsx   # xterm.js wrapper — accepts sessionId prop; OSC 6800, OSC 7, and OSC 7337 handlers; PTY IPC, FitAddon, base64 I/O; module-level per-sid spawn-chain serialises pty_spawn/pty_kill to prevent StrictMode remount races
│       │   ├── index.ts       # Barrel export
│       │   └── Terminal.test.tsx
│       └── layout/
│           ├── AppLayout.tsx          # Mantine Tabs + AppShell — threads sessionContext + onSessionContextChange + onSessionContextPatch to NavBar and Terminal
│           ├── NavBar.tsx             # Sidebar — passes per-card sessionContext to each SessionCard
│           ├── SessionCard.tsx        # 3-row tab label: slug + close button, repo:branch • path-tail, PR/Issue badges; falls back to mock data until OSC 6800 arrives
│           ├── SessionCard.test.tsx   # Unit tests for SessionCard (16 cases)
│           ├── sessionContext.mock.ts # Deterministic mock SessionContext fixtures keyed by card id
│           └── index.ts              # Barrel export
├── src-tauri/        # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs   # Binary entry point
│   │   ├── lib.rs    # Library crate (command handlers)
│   │   └── pty.rs    # PTY session management (spawn/write/resize/kill commands); generation tokens + duplicate-ID rejection prevent orphaned sessions on rapid remount
│   ├── capabilities/ # Tauri permission grants
│   ├── icons/        # App icons (all sizes)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## OSC Session-Context Flow (6800 / 7 / 7337)

AI CLIs running inside a terminal can broadcast structured session context by emitting an OSC 6800 escape sequence:

```
\033]6800;{"SESSION_TS":"20260425-120000","SESSION_SLUG":"my-session",...}\007
```

The data travels through the following layers:

1. **PTY** — the CLI process writes the sequence to its stdout.
2. **`Terminal.tsx`** — xterm.js intercepts OSC 6800, OSC 7, and OSC 7337. The 6800 handler dispatches a full SessionContext via onSessionContextChange; the 7 and 7337 handlers dispatch partial merges via onSessionContextPatch. Each handler delegates parsing to a dedicated parser in sessionPayload.ts, then wraps the dispatch in queueMicrotask to avoid re-entering the parser synchronously. The handlers are cleaned up on component unmount.
3. **`parseSessionContextPayload()` / `parseOsc7Payload()` / `parseOsc7337Payload()` (`src/types/sessionPayload.ts`)** — single audit entry point for all OSC payload validation. Returns SessionContext / Partial<SessionContext> / null respectively. Never throw.
4. **`App.tsx` reducer** — `setSessionContext` action stores a validated SessionContext in `AppState.sessionContext` (full replacement). `patchSessionContext` merges OSC 7 / OSC 7337 fields into the existing record. **It is a no-op if no record exists for that card id — OSC 6800 must initialise first; the no-op fires a DEV-only console.debug for observability.**
5. **`SessionCard.tsx`** — reads its card's entry from `sessionContext`; falls back to `sessionContext.mock.ts` fixtures until the first valid OSC 6800 payload arrives for that tab.

All `SessionContext` fields are treated as untrusted user-controlled data and must only be rendered as text. See [security.md](security.md) for the rendering constraint.
