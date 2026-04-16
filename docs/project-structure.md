# Project Structure

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
