# ai-dungeon

Multi-workspace terminal for AI agents and CLIs.

## Tech Stack

| Layer           | Technology                                |
| --------------- | ----------------------------------------- |
| Desktop shell   | [Tauri v2](https://v2.tauri.app/)         |
| Frontend        | React 19 + TypeScript                     |
| UI library      | [Mantine v8](https://v8.mantine.dev/)     |
| Bundler         | Vite 7 (PostCSS via `postcss.config.cjs`) |
| Package manager | pnpm                                      |
| Backend         | Rust (Cargo)                              |

## Project Structure

```
ai-dungeon/
├── src/              # React + TypeScript frontend
│   ├── main.tsx      # Entry point — mounts MantineProvider
│   ├── App.tsx       # Root component — wrapped in AppLayout
│   └── components/
│       └── layout/
│           ├── AppLayout.tsx  # AppShell layout (header, navbar, main)
│           └── index.ts       # Barrel export
├── src-tauri/        # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs   # Binary entry point
│   │   └── lib.rs    # Library crate (command handlers)
│   ├── capabilities/ # Tauri permission grants
│   ├── icons/        # App icons (all sizes)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## Prerequisites

- **Rust** — install via rustup:
  ```sh
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- **Node.js** v18 or later
- **pnpm**:
  ```sh
  npm install -g pnpm
  ```

## Development

Install dependencies:

```sh
pnpm install
```

Start the Vite dev server and open the native window:

```sh
pnpm tauri dev
```

The Vite dev server runs on port 1420. The Rust backend is compiled on first run, which takes a few minutes while Cargo downloads crates.

### Code Quality

The project uses [Oxlint](https://oxc.rs/docs/guide/usage/linter) for linting and [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) for formatting.

| Command             | Effect                           |
| ------------------- | -------------------------------- |
| `pnpm lint`         | Lint the codebase                |
| `pnpm lint:fix`     | Lint and auto-fix violations     |
| `pnpm format`       | Format all files in-place        |
| `pnpm format:check` | Check formatting without writing |

## Testing

See [TESTING.md](TESTING.md) for the full guide, including setup, configuration decisions, and coverage.

| Command         | What it runs                                       |
| --------------- | -------------------------------------------------- |
| `pnpm test`     | Vitest — unit and component tests (single run)     |
| `pnpm coverage` | Vitest — tests with V8 coverage report             |
| `pnpm test:e2e` | Playwright — E2E tests against the Vite dev server |

- **Unit/component tests** (Vitest + React Testing Library) live in `src/` alongside source files.
- **E2E tests** (Playwright) live in `e2e/` and run against the Vite dev server, not the compiled Tauri backend.

## Build

Produce a release binary (and `.app` bundle on macOS):

```sh
pnpm tauri build
```

Output is placed under `src-tauri/target/release/`.

## Security Notes

The app ships with a restrictive Content Security Policy that limits sources to `'self'` and the Tauri IPC/asset origins. Tauri capabilities are scoped to `core:default` only — no filesystem, shell, or HTTP client permissions are granted by default. Both are intentional baselines; extend them in `src-tauri/capabilities/` and `tauri.conf.json` as features are added.
