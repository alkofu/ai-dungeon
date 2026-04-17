# Project Structure

```
ai-dungeon/
├── src/              # React + TypeScript frontend
│   ├── main.tsx      # Entry point — mounts MantineProvider
│   ├── App.tsx       # Root component; owns card list state
│   ├── App.test.tsx
│   ├── types/
│   │   └── card.ts   # Card interface (shared across components)
│   ├── components/
│   │   └── layout/
│   │       ├── AppLayout.tsx  # AppShell layout; forwards card props to NavBar
│   │       ├── NavBar.tsx     # Controlled card list — add/remove via callbacks
│   │       ├── NavBar.test.tsx
│   │       └── index.ts       # Barrel export
│   └── test-utils/
│       ├── render.tsx  # renderWithProviders helper (wraps MantineProvider)
│       └── setup.ts    # Vitest setup file
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
