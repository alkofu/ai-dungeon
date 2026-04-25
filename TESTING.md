# Testing

## Testing Architecture

ai-dungeon uses three testing layers:

1. **Unit and component tests** — Vitest + React Testing Library, covering individual React components and utilities in isolation using a jsdom DOM environment.
2. **End-to-end tests** — Playwright, covering full user flows in a real Chromium browser against the running Vite dev server.
3. **Rust tests** — future work; see the Rust Tests section below.

## Quick Reference

| Command           | Description                       |
| ----------------- | --------------------------------- |
| `pnpm test`       | Run all unit/component tests once |
| `pnpm test:watch` | Run tests in watch mode           |
| `pnpm test:ui`    | Open Vitest browser UI            |
| `pnpm coverage`   | Run tests with V8 coverage report |
| `pnpm test:e2e`   | Run Playwright E2E tests          |

## Unit and Component Tests (Vitest)

Test files live in `src/` alongside source files, using the `.test.tsx` or `.test.ts` suffix (e.g., `src/App.test.tsx`).

Vitest is configured inside `vite.config.ts` via a `test` block — there is no separate `vitest.config.ts`. This lets Vitest reuse the existing Vite plugin and alias setup without duplication.

The DOM environment is `jsdom`. `@testing-library/react` (v16.1.0+, required for React 19 support) is used for rendering and querying components.

### renderWithProviders

A `renderWithProviders` helper is available at `src/test-utils/render.tsx`. It wraps components in `<MantineProvider>`, matching the provider tree in `main.tsx`. Use it instead of bare `render()` for any component that depends on context providers — any component using Mantine hooks or components will fail to render without this wrapper.

If additional providers are added later (router, state management, etc.), update `src/test-utils/render.tsx` accordingly so the test wrapper stays in sync with `main.tsx`.

### jsdom stubs for xterm.js

xterm.js requires `HTMLCanvasElement.getContext` and `ResizeObserver`, neither of which jsdom implements. `src/test-utils/setup.ts` installs global stubs for both so that any test that renders a component tree containing `<Terminal />` does not throw.

The canvas stub returns a minimal `CanvasRenderingContext2D`-shaped object (all methods are `vi.fn()`). The `ResizeObserver` stub is installed unconditionally in `setup.ts`; `Terminal.test.tsx` overrides it per-test with a fresh spy so it can assert on `disconnect` calls during unmount.

`Terminal.test.tsx` mocks `@xterm/xterm` and `@xterm/addon-fit` at the module level with class spies rather than relying on a real renderer. xterm 5.x's DOM renderer requires layout APIs (`clientWidth`/`clientHeight`, canvas, WebGL) that jsdom does not provide, so assertions are made against the spies (e.g., `writeln`, `dispose`, `fit`) rather than against rendered terminal rows.

## E2E Tests (Playwright)

Test files live in the top-level `e2e/` directory, separate from the unit tests in `src/`.

Playwright is configured in `playwright.config.ts` at the repo root. It auto-starts the Vite dev server on port 1420 via `webServer.port` (which also implicitly sets `baseURL`; the config makes this explicit for clarity). Only Chromium is configured initially.

**Prerequisites:** After `pnpm install` on a fresh checkout, run:

```
npx playwright install chromium
```

This downloads the Chromium browser binary. Without it, `pnpm test:e2e` will fail with a "browser not installed" error.

## Coverage

`pnpm coverage` generates HTML, text summary, and lcov reports in the `coverage/` directory using V8 native coverage (no instrumentation required). The `coverage/` directory is gitignored.

## Manual PTY Verification

After `pnpm tauri dev` opens the app window, perform the following checks to confirm the real PTY integration is working end-to-end.

1. **Basic shell interaction** — Type `pwd` and press Enter. Confirm the current working directory is printed (should be your home directory).
2. **Shell identity** — Type `echo $SHELL` and press Enter. Confirm the output matches your default shell (e.g. `/bin/zsh` or `/bin/bash`).
3. **Terminal type** — Type `echo $TERM` and press Enter. Confirm the output is `xterm-256color`.
4. **PTY dimensions** — Type `stty size` and press Enter. Confirm the output matches the visible terminal dimensions (rows × cols). Resize the window and run `stty size` again to confirm the dimensions update.
5. **Shell exit** — Type `exit` and press Enter. Confirm `[process exited]` appears in the terminal and the shell does not auto-respawn.
6. **Orphan check** — After the window is closed (or `exit` is run), verify no lingering shell processes remain: `ps aux | grep -v grep | grep "$(basename $SHELL)"` should not show a process owned by the app.
7. **Broken shell path** — In `src/components/Terminal/Terminal.tsx`, temporarily set the `pty_spawn` call to use an invalid shell path. Confirm the terminal displays `[failed to start shell: ...]` instead of crashing silently.
8. **Binary paste** — Paste a chunk of text containing special characters (e.g. emoji, accented characters, or a long block of text). Confirm the characters arrive correctly in the shell without corruption or truncation.

## CI

`pnpm lint`, `pnpm format:check`, and `pnpm test` run automatically on every pull request and push to `main` via the `check` job in `.github/workflows/test.yml`.

Branch protection rules should be configured to require the `check` job before merging (follow-up item).

## Rust Tests (Future Work)

The Rust backend (`src-tauri/`) exposes four PTY commands — `pty_spawn`, `pty_write`, `pty_resize`, and `pty_kill` — implemented in `src-tauri/src/pty.rs`. Unit tests for these commands require a real PTY device, which is unavailable in most CI environments and non-trivial to mock at the `portable-pty` trait boundary. Rust unit tests for the PTY layer are therefore deferred as future work. When added, they will use standard `#[cfg(test)]` modules and `cargo test`. No additional Rust test dependencies are anticipated.
