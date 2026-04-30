# ai-dungeon

A desktop tool for managing AI CLIs like [Claude Code](https://claude.com/claude-code) and [OpenCode](https://opencode.ai/) — a multi-workspace terminal environment where developers can launch, organize, and interact with multiple AI CLI sessions side by side.

## Why ai-dungeon?

AI coding assistants increasingly run as CLIs that hold long-lived, stateful sessions. Juggling several of them across projects in plain terminal tabs is awkward: sessions get lost, context is hard to keep separate, and switching between agents breaks flow. ai-dungeon gives each agent and each project a dedicated workspace inside one native desktop app, so you can keep multiple AI sessions running, organized, and reachable at a glance.

## Key Features

- **Card-as-tab workspace** — each card in the sidebar is a vertical tab. Cards have a type: `terminal` cards open a PTY session (shell keeps running and scrollback is intact even when a tab is not visible); `dungeon` cards connect to a Python sidecar process and expose Hi / Clean buttons for round-trip IPC. Clicking a tab switches which card is visible in the main pane.
- **Keyboard tab navigation** — global shortcuts work whether focus is in the terminal or the sidebar. `Cmd+ArrowLeft` / `Cmd+ArrowRight` (macOS) or `Ctrl+ArrowLeft` / `Ctrl+ArrowRight` (Windows/Linux) cycle tabs with wrap-around. `Cmd/Ctrl+1` through `Cmd/Ctrl+9` jump directly to a tab by position. All eleven shortcuts suppress the WebView's default back/forward navigation unconditionally. Holding the modifier key (`Cmd` on macOS, `Ctrl` on Windows/Linux) for ≥ 250 ms reveals shortcut labels (`⌘1`–`⌘9` or `Ctrl+1`–`Ctrl+9`) on the first nine session cards as a discoverability hint; a quick tap that activates a shortcut produces no label flash.
- **Multiple AI CLIs in one place** — designed to host tools like Claude Code, OpenCode, and other terminal-based AI assistants.
- **Native desktop app** — built on Tauri v2 for a fast, lightweight shell around a modern web UI.
- **Live session metadata** — each terminal card holds two independent context slots: `sessionContext` (populated by OSC 6800 — AI CLI session metadata: slug, repo, branch, PR/issue numbers) and `shellContext` (populated by OSC 7 + OSC 7337 — shell CWD and git context). The sidebar card renders whichever slot is available, preferring `sessionContext` over `shellContext`, with mock placeholder data as the fallback. All incoming data is validated before it enters app state. See [docs/project-structure.md](docs/project-structure.md#osc-session-context-flow-6800--7--7337).
- **Powerlevel10K / Nerd Font rendering** — the embedded terminal vendors the MesloLGS NF Nerd Font and preloads it before xterm.js opens, so Powerlevel10K powerline glyphs and icons render with correct spacing out of the box. The PTY also exports a UTF-8 locale on Unix so non-ASCII prompt characters are not corrupted. `TERM_PROGRAM=ai-dungeon` is exported on every platform so child processes (e.g., AI CLIs) can detect they are running inside ai-dungeon. See [docs/project-structure.md](docs/project-structure.md#meslolgs-nf--xterm-font-loading) for the design rationale.
- **User settings** — a gear button (⚙) in the AppShell header opens a Settings modal with two controls: Color scheme (Light / Dark / Auto) and Terminal font size (6–48 pt, default 13). Changes apply instantly without a save button or app reload. Settings persist to `appConfigDir()/settings.json` (macOS: `~/Library/Application Support/com.alkofu.ai-dungeon/settings.json`) as human-readable JSON. A missing or corrupt file silently falls back to defaults; no crash or error UI is shown.
- **Secure by default** — restrictive Content Security Policy and minimal Tauri capabilities out of the box. See [docs/security.md](docs/security.md).
- **Live session context in the navbar** — each `SessionCard` in the sidebar shows the shell's current working directory and git context (repo name + active branch) in its second row, updated after every command via OSC 7 and OSC 7337 escape sequences. When git context is present, row 2 shows `repo : branch • path-tail`; otherwise only the path-tail is shown. Supported shells: bash and zsh. Fish and csh are not supported in this iteration.

## UI Overview

The app uses a three-part Mantine `AppShell`:

- **Header** — app title, navbar toggle, and a gear button (⚙) that opens the Settings modal.
- **Navbar (left sidebar)** — a "Cards" section with a `+` menu button. Clicking the button opens a dropdown with two options: **Terminal** (spawns a PTY session) and **Dungeon** (connects to the Python sidecar). Each card is a `Tabs.Tab` whose label is rendered by the `SessionCard` component: a 3-row block showing the session slug, `repo:branch • path-tail`, and PR / Issue badges. Clicking the tab activates the corresponding card; the `×` button in the top-right of each card removes it. Removing a terminal card kills its PTY session; removing a dungeon card has no PTY side effect.
- **Main pane** — one `Tabs.Panel` per card. Terminal cards contain an xterm.js terminal connected to a real shell via Tauri IPC; inactive panels are hidden with CSS (`display: none`) but remain mounted, keeping PTY sessions alive. While a terminal card is initialising — covering both the lazy-chunk download window and the post-mount PTY spawn window — the panel shows a centred Mantine `<Loader>` spinner with the text "loading…". The indicator disappears the moment the terminal is fully rendered (font loaded, PTY spawned, first paint). Dungeon cards render a `DungeonPanel` with **Hi** and **Clean** buttons: pressing Hi sends a message to the Python sidecar over piped stdio and displays its reply; pressing Clean resets the display.

When there are no cards, the main pane shows an empty-state prompt and the sidebar shows "No cards yet".

### Settings

The Settings modal (gear button in the header) exposes two preferences:

| Setting            | Values              | Default | Effect                                                                                                              |
| ------------------ | ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| Color scheme       | Light / Dark / Auto | Auto    | `Auto` follows the OS `prefers-color-scheme` media query; the other options force a specific theme unconditionally. |
| Terminal font size | 6–48 pt             | 13      | Applied to the live terminal immediately — no re-spawn, no lost shell state.                                        |

Settings are persisted to `appConfigDir()/settings.json`:

- **macOS:** `~/Library/Application Support/com.alkofu.ai-dungeon/settings.json`
- **Windows:** `%APPDATA%\com.alkofu.ai-dungeon\settings.json`
- **Linux:** `~/.config/com.alkofu.ai-dungeon/settings.json`

The file is two-space-indented JSON and includes a `version` field (`1` for v1) for forward-compatible migration. It is safe to edit by hand; a corrupt or missing file causes a silent fallback to defaults on the next launch.

> **Behavioural change (v1 settings release):** The default color scheme is now `"auto"`. Before this change, the app always launched in light mode. Users whose OS is in dark mode will now see the dark theme on first launch. To restore the previous behaviour, open Settings and set Color scheme to Light; that choice persists across restarts.

### Terminal context (OSC 7 / OSC 7337)

At PTY spawn time the Rust backend injects a small shell hook (`PROMPT_COMMAND` for bash, `precmd` for zsh). After every command the hook emits two escape sequences: OSC 7 encodes the CWD as a `file://` URI and OSC 7337 carries a `CurrentDir` notification. xterm.js intercepts both via `parser.registerOscHandler` and writes the parsed values into the card's `shellContext` slot (`ShellContext`: `workingDirectory`, `branch`, `repo`) held in the top-level `AppState`. OSC 7 and OSC 7337 populate `shellContext` independently — no prior OSC 6800 signal is required. OSC 6800 separately populates the card's `sessionContext` slot (`SessionContext`: `sessionTs`, `slug`, `workingDirectory`, `branch`, `repo`, optional PR/issue numbers). The two slots are never merged; `AppLayout` threads each tab's `CardContext` (containing both slots) through `NavBar` to the corresponding `SessionCard`, where row 2 renders `repo : branch • path-tail` (git present) or just the path-tail right-aligned (no git). Each tab's context is independent and survives tab switches.

Manual verification steps for this feature are in [TESTING.md § OSC 7 / OSC 7337 verification](TESTING.md#osc-7--osc-7337-verification).

## Quick Start

```sh
pnpm install
pnpm tauri dev
```

This installs dependencies and launches the app in development mode. You will need Rust, Node.js v18+, and pnpm installed first — see [docs/getting-started.md](docs/getting-started.md) for full prerequisites and setup instructions.

## Documentation

- [Getting Started](docs/getting-started.md) — prerequisites, development workflow, and code quality tooling.
- [Tech Stack](docs/tech-stack.md) — the libraries and tools that power ai-dungeon.
- [Project Structure](docs/project-structure.md) — directory layout and key files.
- [OSC Protocol](docs/osc-protocol.md) — OSC 6800 / 7 / 7337 contract for producer implementations (e.g. ai-tpk).
- [Build](docs/build.md) — producing a release binary.
- [Security Notes](docs/security.md) — CSP and Tauri capability defaults.

## Testing

See [TESTING.md](TESTING.md) for the full guide, including setup, configuration decisions, and coverage.

| Command         | What it runs                                       |
| --------------- | -------------------------------------------------- |
| `pnpm test`     | Vitest — unit and component tests (single run)     |
| `pnpm coverage` | Vitest — tests with V8 coverage report             |
| `pnpm test:e2e` | Playwright — E2E tests against the Vite dev server |

- **Unit/component tests** (Vitest + React Testing Library) live in `src/` alongside source files.
- **E2E tests** (Playwright) live in `e2e/` and run against the Vite dev server, not the compiled Tauri backend.

## License

See [LICENSE](LICENSE).
