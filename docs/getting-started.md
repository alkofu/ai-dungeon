# Getting Started

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
