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
