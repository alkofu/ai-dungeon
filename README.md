# ai-dungeon

A desktop tool for managing AI CLIs like [Claude Code](https://claude.com/claude-code) and [OpenCode](https://opencode.ai/) — a multi-workspace terminal environment where developers can launch, organize, and interact with multiple AI CLI sessions side by side.

## Why ai-dungeon?

AI coding assistants increasingly run as CLIs that hold long-lived, stateful sessions. Juggling several of them across projects in plain terminal tabs is awkward: sessions get lost, context is hard to keep separate, and switching between agents breaks flow. ai-dungeon gives each agent and each project a dedicated workspace inside one native desktop app, so you can keep multiple AI sessions running, organized, and reachable at a glance.

## Key Features

- **Card-as-tab terminals** — each card in the sidebar is a vertical tab; clicking it switches which terminal is visible in the main pane. PTY sessions are preserved across switches — the shell keeps running and scrollback is intact even when a tab is not visible.
- **Multiple AI CLIs in one place** — designed to host tools like Claude Code, OpenCode, and other terminal-based AI assistants.
- **Native desktop app** — built on Tauri v2 for a fast, lightweight shell around a modern web UI.
- **Secure by default** — restrictive Content Security Policy and minimal Tauri capabilities out of the box. See [docs/security.md](docs/security.md).

## UI Overview

The app uses a three-part Mantine `AppShell`:

- **Header** — app title and navbar toggle.
- **Navbar (left sidebar)** — a "Cards" section with a `+` button to add cards. Each card is a `Tabs.Tab`; clicking it activates the corresponding terminal. A small `×` button on each tab removes the card and kills its PTY session.
- **Main pane** — one `Tabs.Panel` per card, each containing an xterm.js terminal connected to a real shell via Tauri IPC. Inactive panels are hidden with CSS (`display: none`) but remain mounted, keeping their PTY sessions alive.

When there are no cards, the main pane shows an empty-state prompt and the sidebar shows "No cards yet".

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
