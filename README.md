# ai-dungeon

A desktop tool for managing AI CLIs like [Claude Code](https://claude.com/claude-code) and [OpenCode](https://opencode.ai/) — a multi-workspace terminal environment where developers can launch, organize, and interact with multiple AI CLI sessions side by side.

## Why ai-dungeon?

AI coding assistants increasingly run as CLIs that hold long-lived, stateful sessions. Juggling several of them across projects in plain terminal tabs is awkward: sessions get lost, context is hard to keep separate, and switching between agents breaks flow. ai-dungeon gives each agent and each project a dedicated workspace inside one native desktop app, so you can keep multiple AI sessions running, organized, and reachable at a glance.

## Key Features

- **Card-as-tab terminals** — each card in the sidebar is a vertical tab; clicking it switches which terminal is visible in the main pane. PTY sessions are preserved across switches — the shell keeps running and scrollback is intact even when a tab is not visible.
- **Keyboard tab navigation** — global shortcuts work whether focus is in the terminal or the sidebar. `Cmd+ArrowLeft` / `Cmd+ArrowRight` (macOS) or `Ctrl+ArrowLeft` / `Ctrl+ArrowRight` (Windows/Linux) cycle tabs with wrap-around. `Cmd/Ctrl+1` through `Cmd/Ctrl+9` jump directly to a tab by position. All eleven shortcuts suppress the WebView's default back/forward navigation unconditionally.
- **Multiple AI CLIs in one place** — designed to host tools like Claude Code, OpenCode, and other terminal-based AI assistants.
- **Native desktop app** — built on Tauri v2 for a fast, lightweight shell around a modern web UI.
- **Live session metadata** — terminals receive structured session info (slug, repo, branch, working directory, PR/issue numbers) via OSC 6800 escape sequences emitted by the CLI. Each tab's sidebar card updates automatically; tabs that have not yet emitted a payload display placeholder data. All incoming data is validated before it enters app state. See [docs/project-structure.md](docs/project-structure.md#osc-session-context-flow-6800--7--7337).
- **Powerlevel10K / Nerd Font rendering** — the embedded terminal vendors the MesloLGS NF Nerd Font and preloads it before xterm.js opens, so Powerlevel10K powerline glyphs and icons render with correct spacing out of the box. The PTY also exports a UTF-8 locale on Unix so non-ASCII prompt characters are not corrupted. See [docs/project-structure.md](docs/project-structure.md#meslolgs-nf--xterm-font-loading) for the design rationale.
- **Secure by default** — restrictive Content Security Policy and minimal Tauri capabilities out of the box. See [docs/security.md](docs/security.md).
- **Live session context in the navbar** — each `SessionCard` in the sidebar shows the shell's current working directory and git context (repo name + active branch) in its second row, updated after every command via OSC 7 and OSC 7337 escape sequences. When git context is present, row 2 shows `repo : branch • path-tail`; otherwise only the path-tail is shown. Supported shells: bash and zsh. Fish and csh are not supported in this iteration.

## UI Overview

The app uses a three-part Mantine `AppShell`:

- **Header** — app title and navbar toggle.
- **Navbar (left sidebar)** — a "Cards" section with a `+` button to add cards. Each card is a `Tabs.Tab` whose label is rendered by the `SessionCard` component: a 3-row block showing the session slug, `repo:branch • path-tail`, and PR / Issue badges. Clicking the tab activates the corresponding terminal; the `×` button in the top-right of each card removes it and kills its PTY session.
- **Main pane** — one `Tabs.Panel` per card, each containing an xterm.js terminal connected to a real shell via Tauri IPC. Inactive panels are hidden with CSS (`display: none`) but remain mounted, keeping their PTY sessions alive.

When there are no cards, the main pane shows an empty-state prompt and the sidebar shows "No cards yet".

### Terminal context (OSC 7 / OSC 7337)

At PTY spawn time the Rust backend injects a small shell hook (`PROMPT_COMMAND` for bash, `precmd` for zsh). After every command the hook emits two escape sequences: OSC 7 encodes the CWD as a `file://` URI and OSC 7337 carries a `CurrentDir` notification. xterm.js intercepts both via `parser.registerOscHandler` and merges the parsed values into the per-tab `SessionContext` (sessionTs, slug, workingDirectory, branch, repo, optional PR/issue numbers) held in the top-level `AppState`. OSC 6800 fully replaces the record; OSC 7 (working directory) and OSC 7337 (git branch, plus repo when emitted in `owner/name` form) merge their fields into the existing record once OSC 6800 has initialised it. **OSC 7 and OSC 7337 alone do not initialise a card's record — OSC 6800 must arrive first; patches against a missing record are silently dropped (with a DEV-only `console.debug`).** `AppLayout` threads each tab's context through `NavBar` to the corresponding `SessionCard`, where row 2 renders `repo : branch • path-tail` (git present) or just the path-tail right-aligned (no git). Each tab's context is independent and survives tab switches.

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
