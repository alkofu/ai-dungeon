# Project Structure

```
ai-dungeon/
├── python/
│   ├── sidecar.py        # Python sidecar: reads line-delimited JSON from stdin, replies with {"id": ..., "reply": "Hello"} on stdout. Spawned by the Rust backend on the first dungeon card open; killed on the last close. Dev-mode only — no production bundling.
│   └── test_sidecar.py   # pytest suite for sidecar.py wire-protocol behaviour.
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
│   │   ├── card.ts               # Card interface ({ id: string; type: CardType }) and CardType = "terminal" | "dungeon"; type is set at creation and never mutated
│   │   ├── session.ts            # SessionContext (OSC 6800) and ShellContext (OSC 7/7337) interfaces; all values are UNTRUSTED. branch and repo are optional on both types (cleared by empty OSC 7337).
│   │   ├── sessionPayload.ts     # parseSessionContextPayload() / parseOsc7Payload() / parseOsc7337Payload() — validate all inbound OSC payloads before they enter app state. Single audit entry point for OSC 6800, OSC 7, and OSC 7337.
│   │   └── sessionPayload.test.ts
│   └── components/
│       ├── Terminal/
│       │   ├── Terminal.tsx          # xterm.js wrapper — accepts sessionId prop; OSC 6800, OSC 7, and OSC 7337 handlers; PTY IPC, FitAddon, WebFontsAddon, base64 I/O; module-level per-sid spawn-chain serialises pty_spawn/pty_kill to prevent StrictMode remount races; awaits loadFonts() before term.open()
│       │   ├── useDungeonSidecar.ts  # Hook: calls dungeon_open on mount and dungeon_close on unmount; promise-chain serialisation prevents StrictMode close-before-open races
│       │   ├── useDungeonSend.ts     # Hook: exposes sendHi() — invokes the dungeon_send Tauri command with msg="Hi" and returns the sidecar reply string
│       │   ├── useDungeonSend.test.ts
│       │   ├── index.ts              # React.lazy dynamic import boundary — re-exports Terminal via React.lazy() so the xterm payload (~349 KB) is split into an async chunk instead of the synchronous initial bundle. Consumers must wrap <Terminal> in a <Suspense> boundary.
│       │   └── Terminal.test.tsx
│       └── layout/
│           ├── AppLayout.tsx          # Mantine Tabs + AppShell — branches cards.map on card.type: terminal cards render <Terminal> (wrapped in Suspense with a full-size transparent div fallback), dungeon cards render <DungeonPanel>; includes assertNever exhaustiveness guard; threads sessionContext + shellContext callbacks to NavBar and Terminal
│           ├── DungeonPanel.tsx       # Dungeon card panel — mounts useDungeonSidecar and useDungeonSend; renders Hi / Clean buttons; displays sidecar reply or error text
│           ├── DungeonPanel.test.tsx
│           ├── NavBar.tsx             # Sidebar — "+" opens a Mantine Menu with Terminal / Dungeon items; passes per-card sessionContext and shellContext to each SessionCard
│           ├── SessionCard.tsx        # 3-row tab label: slug + close button, repo:branch • path-tail, PR/Issue badges; rendering precedence: sessionContext ?? shellContext ?? mock
│           ├── SessionCard.test.tsx   # Unit tests for SessionCard (two-slot rendering + legacy cases)
│           ├── sessionContext.mock.ts  # Deterministic mock SessionContext fixtures keyed by card id
│           └── index.ts              # Barrel export
├── src-tauri/        # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs   # Binary entry point
│   │   ├── lib.rs    # Library crate (command handlers)
│   │   ├── pty.rs    # PTY session management (spawn/write/resize/kill commands); generation tokens + duplicate-ID rejection prevent orphaned sessions on rapid remount; exports TERM_PROGRAM=ai-dungeon for child-process self-identification; exports LC_ALL with UTF-8 locale on Unix; bash/zsh sessions additionally receive `__ai_dungeon_emit_ctx` via per-session shell-startup-file injection (ZDOTDIR override for zsh, --rcfile for bash) so the hook is wired before ZLE binds the keyboard
│   │   └── dungeon.rs  # Python sidecar lifecycle — DungeonState (Arc<Mutex<DungeonInner>>), dungeon_open / dungeon_close / dungeon_send Tauri commands; reader thread routes sidecar stdout to per-request reply channels; testable inner functions
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

## Python Sidecar Lifecycle

A single Python sidecar process (`python/sidecar.py`) is spawned when the first dungeon card opens and killed when the last dungeon card closes. The sidecar is a process-wide singleton: opening additional dungeon cards never spawns more than one process, and closing some-but-not-all cards leaves it running.

### Why a reference-counted singleton?

Dungeon cards share one long-running Python process. Tying the sidecar lifetime to "any dungeon card is open" keeps the resource alive exactly as long as it is needed without spawning duplicate processes. A reference-counted design also enforces symmetry — every `dungeon_open` call is paired with exactly one `dungeon_close`, which prevents counter underflow and ensures the child is reaped on the final close.

### Rust layer (`src-tauri/src/dungeon.rs`)

`DungeonState` wraps `DungeonInner` in an `Arc<Mutex<...>>` so it can be cloned into `spawn_blocking` closures. `DungeonInner` holds:

- `open_count: u32` — reference count of mounted dungeon cards.
- `child: Option<Child>` — the running sidecar process handle.
- `stdin: Option<ChildStdin>` — write end of the sidecar's stdin pipe; `None` when not running.
- `pending: Arc<Mutex<HashMap<String, SyncSender<String>>>>` — registry mapping request `id` to per-request reply channels; shared with the reader thread.
- `next_request_id: u64` — monotonic counter for generating unique request IDs.

Three Tauri commands drive the state:

- `dungeon_open` — increments `open_count`. On the 0 → 1 transition, spawns `python3 python/sidecar.py` with piped stdin/stdout (debug builds only; release builds log and skip), stores the stdin handle, and starts the reader thread. The count is incremented even when spawn fails, preserving open/close symmetry.
- `dungeon_close` — decrements `open_count`. On the N → 0 transition: drops `stdin` (triggers sidecar EOF exit), drains `pending` (causes in-flight `dungeon_send` calls to resolve with a "channel closed" error), then kills and waits on the child process to avoid Unix zombies.
- `dungeon_send` — sends a JSON message to the sidecar and awaits the reply. Implemented via `spawn_blocking`: generates a unique request ID, inserts a `SyncSender` into `pending`, writes `{"id": "...", "msg": "..."}` as a newline-delimited JSON line to stdin, and blocks on a `recv_timeout` (5 s). The reader thread delivers the reply by `id`.

The **reader thread** (`spawn_reader_thread`) runs for the lifetime of the sidecar process. It reads newline-delimited JSON from the sidecar's stdout, extracts `id` and `reply` fields, looks up the matching `SyncSender` in `pending`, removes it, and sends the reply string. Parse errors and unknown IDs are logged to stderr and skipped; the thread exits when stdout closes.

The script path is resolved at compile time via `env!("CARGO_MANIFEST_DIR")` joined with `../python/sidecar.py`, so `cargo tauri dev` works on a fresh checkout without configuration. Spawn failures surface as `eprintln!` log lines and do not block card creation.

The inner logic is split into `dungeon_open_with_spawner` (accepts an `Option<R>` reader callback — `Some` in production, `None` in unit tests that do not need the reader thread), `dungeon_close_inner`, and `dungeon_send_inner_blocking` so unit tests can inject a fast-exiting `/bin/sh` child and a `Vec<u8>` writer instead of requiring Python or a real process on CI.

### Frontend layer

**`src/types/card.ts` — `isDungeonCard(card)`**

The single predicate that decides whether a card participates in the sidecar lifecycle. It returns `true` when `card.type === "dungeon"`. The predicate must not be inlined at call sites; all consumers import it by name.

**`src/components/Terminal/useDungeonSidecar.ts`**

React hook mounted once per dungeon card (from `DungeonPanel`). On mount it calls `dungeon_open`; its cleanup calls `dungeon_close`. Both calls are chained on a `chainRef` promise so that React 19 StrictMode's rapid mount → unmount → remount sequence always delivers open before close at the Rust backend — the same serialisation pattern used by `Terminal.tsx` for `pty_spawn`/`pty_kill`. Invoke rejections are caught and logged to `console.warn`; they do not throw inside the effect.

**`src/components/Terminal/useDungeonSend.ts`**

React hook that wraps the `dungeon_send` Tauri command. Exposes a single `sendHi()` callback that invokes `dungeon_send` with `msg: "Hi"` and returns the sidecar's reply string. The callback is stable across renders (`useCallback` with an empty dependency array).

**`src/components/layout/DungeonPanel.tsx`**

Per-dungeon-card panel component. Mounts `useDungeonSidecar` (lifecycle) and `useDungeonSend` (IPC). Renders two buttons:

- **Hi** — calls `sendHi()` and displays the sidecar reply string below the buttons, or an error message in red if the invoke rejects.
- **Clean** — clears both the reply and error state, resetting the panel to its initial appearance.

`AppLayout` renders `<DungeonPanel>` for cards with `type === "dungeon"`.

### Constraints and non-goals (current iteration)

- **IPC is line-delimited JSON over piped stdio only** — no TCP port, no Unix socket, no message bus. Concurrent `dungeon_send` calls are serialised through the `DungeonState` mutex (one in-flight request at a time). This is acceptable while there is a single dungeon card; a writer-actor pattern is the documented upgrade path for concurrent multi-card IPC.
- **No user-visible UI for sidecar lifecycle state** — spawn failures and reader-thread errors surface as `eprintln!` log lines only. The Hi button error display covers `dungeon_send` rejections (e.g., timeout, sidecar not running) but not lifecycle errors.
- **Debug builds only** — the spawn call is gated on `#[cfg(debug_assertions)]`. Release builds log a message and skip spawn entirely. The script path uses a compile-time `CARGO_MANIFEST_DIR` reference that only works in dev mode.
- **`python3`-only** — there is no `python` fallback. The interpreter must be on `PATH` as `python3`.
- **Crash recovery is out of scope** — if the sidecar dies while cards are open, the stale `Child` handle remains until the last card closes. `dungeon_send` calls a `child.try_wait()` liveness check before writing to stdin: if the process has already exited, it returns `Err("sidecar process exited")` immediately rather than waiting for the 5-second reply timeout. A fresh process is spawned on the next 0 → 1 transition.

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
