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

The project uses [Oxlint](https://oxc.rs/docs/guide/usage/linter) for linting and [Oxfmt](https://oxc.rs/docs/guide/usage/formatter) for formatting on the JavaScript/TypeScript side.

| Command             | Effect                           |
| ------------------- | -------------------------------- |
| `pnpm lint`         | Lint the codebase                |
| `pnpm lint:fix`     | Lint and auto-fix violations     |
| `pnpm format`       | Format all files in-place        |
| `pnpm format:check` | Check formatting without writing |

For the Rust backend (`src-tauri/`), the crates enforce `#![deny(unused)]`, so any unused variable, import, or dead code is a **compile error** — `cargo build` will fail, not just warn. Use the following commands to check Rust code quality locally before pushing:

> The commands below require the `clippy` and `rustfmt` rustup components. These are included in rustup's `default` profile. If you used a minimal profile, run: `rustup component add clippy rustfmt`

| Command                                                                          | Effect                                |
| -------------------------------------------------------------------------------- | ------------------------------------- |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Run Clippy; warnings are errors       |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`                      | Check Rust formatting without writing |
| `cargo fmt --manifest-path src-tauri/Cargo.toml`                                 | Auto-format Rust source               |

These checks are also enforced by the `rust` CI job on every pull request.

### Previewing a worktree

Worktrees under `.worktrees/<name>/` can be previewed in isolation without manually `cd`-ing into them — a single command from the repo root handles the full workflow.

```sh
pnpm dev:worktree <worktree-name>
```

Equivalently, you can invoke the script directly:

```sh
bash scripts/dev-worktree.sh <worktree-name>
```

The script assumes worktrees live under `.worktrees/<name>/` — the project's standard git worktree location — so future contributors understand the convention is intentional.

What the script does, in order:

- Validates that the worktree directory exists under `.worktrees/`.
- Checks that port 1420 is free (Tauri's Vite dev server always binds to port 1420; only one preview can run at a time — this is intentional and matches the upstream Vite/Tauri convention).
- Runs `pnpm install --prefer-offline` inside the worktree.
- `exec`s `pnpm tauri dev`, replacing the shell process so Ctrl-C tears down Tauri cleanly.

**Common errors:**

- `Error: worktree '<name>' not found at ...` — the worktree directory does not exist. Run `git worktree list` to see which worktrees are currently checked out.
- `Error: port 1420 is already in use.` — another `pnpm tauri dev` instance (or some other process) is bound to the port. Run `lsof -i :1420` to identify it and stop it before starting a new preview.
