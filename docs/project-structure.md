# Project Structure

```
ai-dungeon/
├── src/              # React + TypeScript frontend
│   ├── main.tsx      # Entry point — mounts MantineProvider, imports xterm CSS
│   ├── App.tsx       # Root component — useReducer for cards + activeId; owns tab state
│   ├── types/
│   │   ├── card.ts               # Card type ({ id: string })
│   │   ├── session.ts            # SessionMeta interface — fields sourced from OSC 6800; all values are UNTRUSTED
│   │   ├── sessionPayload.ts     # parseSessionMetaPayload() — validates raw OSC 6800 JSON before it enters app state
│   │   └── sessionPayload.test.ts
│   └── components/
│       ├── Terminal/
│       │   ├── Terminal.tsx   # xterm.js wrapper — accepts sessionId prop; OSC 6800 handler; PTY IPC, FitAddon, base64 I/O; module-level per-sid spawn-chain serialises pty_spawn/pty_kill to prevent StrictMode remount races
│       │   ├── index.ts       # Barrel export
│       │   └── Terminal.test.tsx
│       └── layout/
│           ├── AppLayout.tsx          # Mantine Tabs + AppShell — threads sessionMeta + onSessionMeta to NavBar and Terminal
│           ├── NavBar.tsx             # Sidebar — passes per-card sessionMeta to each SessionCard
│           ├── SessionCard.tsx        # 3-row tab label: slug + close button, repo:branch • path-tail, PR/Issue badges; falls back to mock data until OSC 6800 arrives
│           ├── SessionCard.test.tsx   # Unit tests for SessionCard (16 cases)
│           ├── sessionMeta.mock.ts    # Deterministic mock SessionMeta fixtures keyed by card id
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

## OSC 6800 Session Metadata Flow

AI CLIs running inside a terminal can broadcast structured session metadata by emitting an OSC 6800 escape sequence:

```
\033]6800;{"SESSION_TS":"20260425-120000","SESSION_SLUG":"my-session",...}\007
```

The data travels through the following layers:

1. **PTY** — the CLI process writes the sequence to its stdout.
2. **`Terminal.tsx`** — xterm.js intercepts the OSC 6800 handler (registered via `terminal.parser.registerOscHandler`). The raw JSON string is dispatched to the app reducer via `queueMicrotask` to avoid re-entering the xterm.js parser synchronously. The handler is cleaned up on component unmount.
3. **`parseSessionMetaPayload()` (`src/types/sessionPayload.ts`)** — validates the raw string before it touches app state. Checks include: 64 K size cap, JSON parse, plain-object type guard, per-field format/length/control-character rules, and `owner/repo` path-traversal defence. Returns `SessionMeta | null`; never throws.
4. **`App.tsx` reducer** — `setSessionMeta` action stores validated `SessionMeta` in `AppState.sessionMeta`, keyed by card id.
5. **`SessionCard.tsx`** — reads its card's entry from `sessionMeta`; falls back to `sessionMeta.mock.ts` fixtures until the first valid OSC 6800 payload arrives for that tab.

All `SessionMeta` fields are treated as untrusted user-controlled data and must only be rendered as text. See [security.md](security.md) for the rendering constraint.
