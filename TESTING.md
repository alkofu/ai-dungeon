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

`Terminal` requires a `sessionId` prop (a stable UUID supplied by the caller). Every `renderWithProviders(<Terminal />)` call in tests must pass an explicit `sessionId`, for example `renderWithProviders(<Terminal sessionId="00000000-0000-0000-0000-000000000001" />)`. Because `NavBar` renders `Tabs.Tab` and `Tabs.List`, tests for `NavBar` must wrap the component in a `<Tabs>` context — see `NavBar.test.tsx` for the pattern.

`SessionCard` is also rendered inside `Tabs.Tab` in production. Its tests therefore wrap each render in `<Tabs value={null} onChange={() => {}} orientation="vertical">` for the same reason. The `stopPropagation` test additionally supplies an `onChange` spy on the `<Tabs>` wrapper to assert that tab activation is not triggered when the close button is clicked — matching the equivalent test in `NavBar.test.tsx`.

### Testing appReducer directly

`appReducer` is exported from `src/App.tsx` as a named export alongside `AppState`. This makes it testable in isolation as a pure function without rendering the `App` component at all. `App.test.tsx` contains a dedicated `describe("appReducer")` block that imports the reducer and `AppState` type directly and asserts on return values without any DOM involvement. When adding reducer logic, prefer adding a case to this describe block first (pure-function tests run faster and give clearer failure messages than component integration tests).

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

### Single-terminal checks

1. **Empty state** — On launch, confirm the main pane shows the "No card selected" prompt and the sidebar shows "No cards yet".
2. **Basic shell interaction** — Click `+` to add a card. Type `pwd` and press Enter. Confirm the current working directory is printed (should be your home directory).
3. **Shell identity** — Type `echo $SHELL` and press Enter. Confirm the output matches your default shell (e.g. `/bin/zsh` or `/bin/bash`).
4. **Terminal type** — Type `echo $TERM` and press Enter. Confirm the output is `xterm-256color`.
5. **PTY dimensions** — Type `stty size` and press Enter. Confirm the output matches the visible terminal dimensions (rows × cols). Resize the window and run `stty size` again to confirm the dimensions update.
6. **Shell exit** — Type `exit` and press Enter. Confirm `[process exited]` appears in the terminal and the shell does not auto-respawn.
7. **Orphan check** — First, _while the app is still running_, verify no zombie shell processes exist: `ps aux | grep -E "$(basename $SHELL).*defunct"` should return empty. Then close the app (or run `exit`) and confirm no lingering shell processes remain: `ps aux | grep -v grep | grep "$(basename $SHELL)"` should not show a process owned by the app.
8. **Broken shell path** — In `src/components/Terminal/Terminal.tsx`, temporarily set the `pty_spawn` call to use an invalid shell path. Confirm the terminal displays `[failed to start shell: ...]` instead of crashing silently.
9. **Binary paste** — Paste a chunk of text containing special characters (e.g. emoji, accented characters, or a long block of text). Confirm the characters arrive correctly in the shell without corruption or truncation.

### Multi-tab checks

10. **Session preservation across tab switches** — Add two cards. In the first tab type a distinctive command (e.g. `echo hello-from-tab-1`). Click the second tab and type something different. Click the first tab again — the first terminal must still show its prior output with the cursor where it was left.
11. **Terminal sizing on activation** — After switching back to a tab that was hidden, confirm the terminal fills the panel without shrinking or showing blank space. Run `stty size` to confirm the dimensions are correct.
12. **Remove active tab** — With two cards, make the second card active. Click its `×` button. Confirm the first card becomes active automatically and its terminal is unaffected.
13. **Remove non-active tab** — With two cards, make the first card active. Click the second card's `×` button. Confirm the first card remains active and its terminal session is unchanged.
14. **Return to empty state** — Remove all cards one by one. Confirm the empty-state prompt reappears in the main pane and "No cards yet" appears in the sidebar.

## CI

`pnpm lint`, `pnpm format:check`, and `pnpm test` run automatically on every pull request and push to `main` via the `check` job in `.github/workflows/test.yml`.

Branch protection rules should be configured to require the `check` job before merging (follow-up item).

### OSC 7 / OSC 7337 verification

After `pnpm tauri dev` opens the app window, perform the following checks to confirm the OSC-based CWD and git context plumbing is working end-to-end.

1. **Status bar initial state** — Open the app and add a card. Confirm the status bar at the bottom of the panel shows `…` for the CWD while the shell prompt is initialising. After pressing Enter (or running any command) the status bar should update to the actual working directory (e.g. your home directory).
2. **CWD update on cd** — Run `cd /tmp` (or any non-git directory). Confirm the CWD in the status bar updates to `/tmp` and the git half of the status bar is empty.
3. **Git context appears on cd into a repo** — Run `cd` back into the ai-dungeon worktree directory. Confirm the right side of the status bar shows `ai-dungeon · feat/implement-osc7-based-solution` (or the current branch name).
4. **Detached HEAD display** — Inside any git repo, run `git checkout --detach HEAD`. Confirm the branch slot on the right shows the short commit hash (e.g. `ai-dungeon · a1b2c3d`) instead of failing or showing an empty string.
5. **Per-card independence** — Add a second card. Confirm each card's status bar tracks its own CWD and git context independently — running `cd /tmp` in card 1 must not change card 2's status bar.
6. **Context persists across tab switches** — Switch between tabs back and forth. Confirm the status bar values for each card are preserved across switches (keepMounted proof).
7. **Hook removal resilience** — In a single session, run `unset PROMPT_COMMAND; precmd_functions=()` (or the equivalent for your shell) to disable the hook. Confirm the status bar stops updating but does not crash. Close and reopen the card — confirm the hook is re-injected on the new PTY and the status bar starts updating again.

## Rust Tests (Future Work)

The Rust backend (`src-tauri/`) exposes four PTY commands — `pty_spawn`, `pty_write`, `pty_resize`, and `pty_kill` — implemented in `src-tauri/src/pty.rs`. Unit tests for these commands require a real PTY device, which is unavailable in most CI environments and non-trivial to mock at the `portable-pty` trait boundary. Rust unit tests for the PTY layer are therefore deferred as future work. When added, they will use standard `#[cfg(test)]` modules and `cargo test`. No additional Rust test dependencies are anticipated.
