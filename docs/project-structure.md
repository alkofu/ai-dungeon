# Project Structure

```
ai-dungeon/
├── public/
│   └── fonts/            # Vendored MesloLGS NF TTF faces (see MesloLGS NF section below)
│       ├── MesloLGS NF Regular.ttf
│       ├── MesloLGS NF Bold.ttf
│       ├── MesloLGS NF Italic.ttf
│       ├── MesloLGS NF Bold Italic.ttf
│       └── README.md     # Provenance, SHA-256 hashes, licence, size rationale
├── src/              # React + TypeScript frontend
│   ├── main.tsx      # Entry point — mounts MantineProvider, imports xterm CSS and fonts.css
│   ├── styles/
│   │   └── fonts.css # @font-face declarations for MesloLGS NF (all four faces)
│   ├── App.tsx       # Root component — useReducer for cards + activeId; owns tab state
│   ├── types/
│   │   ├── card.ts               # Card type ({ id: string })
│   │   ├── session.ts            # SessionContext (OSC 6800) and ShellContext (OSC 7/7337) interfaces; all values are UNTRUSTED. branch and repo are optional on both types (cleared by empty OSC 7337).
│   │   ├── sessionPayload.ts     # parseSessionContextPayload() / parseOsc7Payload() / parseOsc7337Payload() — validate all inbound OSC payloads before they enter app state. Single audit entry point for OSC 6800, OSC 7, and OSC 7337.
│   │   └── sessionPayload.test.ts
│   └── components/
│       ├── Terminal/
│       │   ├── Terminal.tsx   # xterm.js wrapper — accepts sessionId prop; OSC 6800, OSC 7, and OSC 7337 handlers; PTY IPC, FitAddon, WebFontsAddon, base64 I/O; module-level per-sid spawn-chain serialises pty_spawn/pty_kill to prevent StrictMode remount races; awaits loadFonts() before term.open()
│       │   ├── index.ts       # Barrel export
│       │   └── Terminal.test.tsx
│       └── layout/
│           ├── AppLayout.tsx          # Mantine Tabs + AppShell — threads sessionContext + shellContext + their change callbacks to NavBar and Terminal
│           ├── NavBar.tsx             # Sidebar — passes per-card sessionContext and shellContext to each SessionCard
│           ├── SessionCard.tsx        # 3-row tab label: slug + close button, repo:branch • path-tail, PR/Issue badges; rendering precedence: sessionContext ?? shellContext ?? mock
│           ├── SessionCard.test.tsx   # Unit tests for SessionCard (two-slot rendering + legacy cases)
│           ├── sessionContext.mock.ts  # Deterministic mock SessionContext fixtures keyed by card id
│           └── index.ts              # Barrel export
├── src-tauri/        # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs   # Binary entry point
│   │   ├── lib.rs    # Library crate (command handlers)
│   │   └── pty.rs    # PTY session management (spawn/write/resize/kill commands); generation tokens + duplicate-ID rejection prevent orphaned sessions on rapid remount; exports LC_ALL with UTF-8 locale on Unix
│   ├── capabilities/ # Tauri permission grants
│   ├── icons/        # App icons (all sizes)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## MesloLGS NF / xterm font loading

Powerlevel10k prompts require the MesloLGS NF Nerd Font for correct powerline
glyph spacing. The four TTF faces (~10.3 MB total) are vendored under
`public/fonts/` so the app works offline (Tauri runs locally; a CDN is not
an option). See `public/fonts/README.md` for provenance, SHA-256 hashes, and
the SIL Open Font License terms.

**Load-order constraint.** `@xterm/addon-web-fonts` `loadFonts(['MesloLGS NF'])`
must be awaited BEFORE `term.open()` is called. xterm.js measures and caches
glyph widths at `term.open()` time; if the font is still loading at that moment,
measurements are taken against the fallback monospace and are never re-measured,
causing permanent alignment damage. The await is the mechanism that prevents
this; `font-display: block` in `fonts.css` is defense-in-depth only.

**CSS import precondition.** `src/styles/fonts.css` must be imported at module
scope in `src/main.tsx` (it is, immediately after the xterm CSS import). The
`@xterm/addon-web-fonts` API: `loadFonts(string[])` only resolves `FontFace[]`
for `@font-face` rules already registered in `document.fonts`. Vite resolves CSS
imports synchronously at module evaluation, so the import-time guarantee is that
all four `@font-face` rules are in `document.fonts` before any React component
code executes. Without this import, `loadFonts` rejects with the string error
`'font family "MesloLGS NF" not registered in document.fonts'`; the terminal
falls back to the system monospace font via the try/catch in `Terminal.tsx`.

**Binary-size cost.** Vendoring all four faces commits ~10.3 MB of binary data
to git history. Git LFS and font subsetting were considered and rejected (see
`public/fonts/README.md` for the full reasoning). The installed Tauri app binary
is already larger than the font files.

**Upstream caveat.** Some Nerd Font / powerline glyphs may still render
imperfectly in browser-based terminals due to upstream xterm.js limitations
unrelated to font loading. See the xterm.js issue tracker for the current status.

For historical context and the full design rationale, see issue #32.

## OSC Session-Context Flow (6800 / 7 / 7337)

The app uses a two-slot card context model. Each tab card independently accumulates context from two sources:

- **SessionContext** (OSC 6800) — full session snapshot emitted by an AI CLI. Contains slug, workingDirectory, branch, repo, prNumber, issueNumber.
- **ShellContext** (OSC 7 / OSC 7337) — shell-derived context: workingDirectory from OSC 7 (`file://` URI) and branch/repo from OSC 7337.

Rendering precedence in `SessionCard.tsx`: `sessionContext ?? shellContext ?? getMockSessionContext(cardId)`.

An AI CLI emits OSC 6800 like this:

```
\033]6800;{"SESSION_TS":"20260425-120000","SESSION_SLUG":"my-session",...}\007
```

The data travels through the following layers:

1. **PTY** — the CLI process writes the sequence to its stdout.
2. **`Terminal.tsx`** — xterm.js intercepts OSC 6800, OSC 7, and OSC 7337. The 6800 handler dispatches a full SessionContext via `onSessionContextChange`; the 7 and 7337 handlers accumulate a ShellContext in `lastShellContextRef` and dispatch via `onShellContextChange`. Each handler delegates parsing to a dedicated parser in `sessionPayload.ts`, then wraps the dispatch in `queueMicrotask` to avoid re-entering the parser synchronously. The handlers are cleaned up on component unmount.
3. **`parseSessionContextPayload()` / `parseOsc7Payload()` / `parseOsc7337Payload()` (`src/types/sessionPayload.ts`)** — single audit entry point for all OSC payload validation. Returns `SessionContext` / `ShellContext | null` / partial updates / null respectively. Never throw.
4. **`App.tsx` reducer** — `setSessionContext` stores a validated SessionContext in `AppState.sessionContext[id]` (full replacement). `setShellContext` stores a validated ShellContext in `AppState.shellContext[id]` (full replacement). Both are no-ops if the card id is not in `state.cards` — guards against races where an OSC handler fires after the card is removed.
5. **`SessionCard.tsx`** — applies the `sessionContext ?? shellContext ?? mock` precedence. SessionContext is authoritative: an empty OSC 7337 clear does not erase branch/repo on a session-bound card.

All `SessionContext` and `ShellContext` fields are treated as untrusted user-controlled data and must only be rendered as text. See [security.md](security.md) for the rendering constraint. For the full OSC field specification, see [osc-protocol.md](osc-protocol.md).
