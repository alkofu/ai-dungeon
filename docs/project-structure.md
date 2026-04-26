# Project Structure

```
ai-dungeon/
├── src/              # React + TypeScript frontend
│   ├── main.tsx      # Entry point — mounts MantineProvider, imports xterm CSS
│   ├── App.tsx       # Root component — useReducer for cards + activeId; owns tab state
│   ├── types/
│   │   └── card.ts   # Card type ({ id: string })
│   └── components/
│       ├── Terminal/
│       │   ├── Terminal.tsx   # xterm.js wrapper — accepts sessionId prop; PTY IPC, FitAddon, base64 I/O
│       │   ├── index.ts       # Barrel export
│       │   └── Terminal.test.tsx
│       └── layout/
│           ├── AppLayout.tsx  # Mantine Tabs + AppShell — Tabs.List in navbar, Tabs.Panel per card in main
│           ├── NavBar.tsx     # Sidebar — card list as Tabs.Tab items, Add/Remove controls
│           └── index.ts       # Barrel export
├── src-tauri/        # Rust backend (Tauri)
│   ├── src/
│   │   ├── main.rs   # Binary entry point
│   │   ├── lib.rs    # Library crate (command handlers)
│   │   └── pty.rs    # PTY session management (spawn/write/resize/kill commands)
│   ├── capabilities/ # Tauri permission grants
│   ├── icons/        # App icons (all sizes)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```
