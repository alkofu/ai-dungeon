# Testing

## Testing Architecture

ai-dungeon uses three testing layers:

1. **Unit and component tests** — Vitest + React Testing Library, covering individual React components and utilities in isolation using a jsdom DOM environment.
2. **End-to-end tests** — Playwright, covering full user flows in a real Chromium browser against the running Vite dev server.
3. **Rust tests** — `cargo test` unit tests covering PTY session management and locale resolution. See the Rust Tests section below.

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

### E2E specs

| Spec file                             | What it covers                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `e2e/terminal-font-rendering.spec.ts` | Boots the dev server, adds a terminal card, and asserts `document.fonts.check('13px "MesloLGS NF"')` returns `true` — verifying the MesloLGS NF font is loaded before `term.open()` fires (issue #32). |

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
7. **Orphan check** — Use a ppid-filtered approach to avoid conflating the user's interactive shells with app-spawned ones. Find the Tauri process pid: `APP_PID=$(pgrep -f 'ai-dungeon' | head -1)`. Then list shells whose parent is the app: `pgrep -P "$APP_PID" | xargs -I{} ps -p {} -o pid,ppid,command 2>/dev/null`. The output should be empty (no live cards) or list exactly the shells for the currently-open cards — no extras.
8. **Broken shell path** — In `src/components/Terminal/Terminal.tsx`, temporarily set the `pty_spawn` call to use an invalid shell path. Confirm the terminal displays `[failed to start shell: ...]` instead of crashing silently.
9. **Binary paste** — Paste a chunk of text containing special characters (e.g. emoji, accented characters, or a long block of text). Confirm the characters arrive correctly in the shell without corruption or truncation.
10. **Clean first frame (no polyglot echo)** — Open a fresh card and observe the very first content rendered by the terminal before typing anything. The first visible line must be a clean shell prompt. No fragment of the `__ai_dungeon_emit_ctx` function body (e.g. `printf '\033]7;…'`, `git rev-parse`, or any brace/semicolon from the function definition) must appear above the prompt. Repeat for at least three new cards to rule out a race. Test with both bash and zsh (`SHELL=/bin/bash pnpm tauri dev` and `SHELL=/bin/zsh pnpm tauri dev`). Note: the fix relies on per-session shell-startup-file injection (`ZDOTDIR` override for zsh, `--rcfile` for bash) rather than PTY-master ECHO suppression; this check now also implicitly verifies the ZLE-bypass fix (the polyglot runs as part of rc-file evaluation, before ZLE binds the keyboard, so ZLE can never render the bytes as typed input).

### Multi-tab checks

11. **Session preservation across tab switches** — Add two cards. In the first tab type a distinctive command (e.g. `echo hello-from-tab-1`). Click the second tab and type something different. Click the first tab again — the first terminal must still show its prior output with the cursor where it was left.
12. **Terminal sizing on activation** — After switching back to a tab that was hidden, confirm the terminal fills the panel without shrinking or showing blank space. Run `stty size` to confirm the dimensions are correct.
13. **Remove active tab** — With two cards, make the second card active. Click its `×` button. Confirm the first card becomes active automatically and its terminal is unaffected.
14. **Remove non-active tab** — With two cards, make the first card active. Click the second card's `×` button. Confirm the first card remains active and its terminal session is unchanged.
15. **Return to empty state** — Remove all cards one by one. Confirm the empty-state prompt reappears in the main pane and "No cards yet" appears in the sidebar.
16. **No spurious errors on cards 2+** — Click `+` three times to create cards 2, 3, and 4. Inspect every terminal pane. No pane must display `[pty write failed: session not found: …]` or `[failed to start shell: session already exists]` on initial render. Type a command (e.g. `echo ok`) in each terminal and confirm it produces output.
17. **No orphaned shells after rapid add/remove** — Rapidly add five cards, then remove all of them, then add five again. Run the ppid-filtered orphan check from step 7. The shell count must equal the number of currently-live cards exactly. Any excess indicates orphaned processes — treat as a regression and do not merge.

### Keyboard tab navigation checks

18. **Cycle with terminal focus** — Add three cards. Click into the third card's terminal (xterm textarea has focus). Press `Cmd+ArrowRight` (macOS) or `Ctrl+ArrowRight` (Windows/Linux). Confirm the active tab wraps to card 1. Press `Cmd+ArrowLeft` / `Ctrl+ArrowLeft`. Confirm the active tab returns to card 3.
19. **Cycle with sidebar focus** — Click a sidebar card label so focus is in the navbar. Press `Cmd+ArrowRight` / `Ctrl+ArrowRight`. Confirm the active tab changes. The shortcut must work regardless of where focus is in the app.
20. **Direct jump** — Add at least three cards. Press `Cmd+2` / `Ctrl+2`. Confirm the second card becomes active. Press `Cmd+3` / `Ctrl+3`. Confirm the third card becomes active.
21. **Direct jump out of range** — With two cards active, press `Cmd+9` / `Ctrl+9`. Confirm the active tab does not change and no error occurs.
22. **No WebView back-navigation** — Press `Cmd+ArrowLeft` / `Ctrl+ArrowLeft` with only one card open (cycling is a no-op). Confirm the WebView does not navigate back (no blank or prior-page flash).
23. **Shortcut tooltip — appears on hold** — Add three cards. Hold `Cmd` (macOS) or `Ctrl` (Windows/Linux) for roughly half a second without releasing. Confirm that `⌘1`, `⌘2`, `⌘3` (or `Ctrl+1`, `Ctrl+2`, `Ctrl+3`) labels appear on the respective sidebar cards, rendered outside the sidebar clipping boundary (visually to the right of each card). Release the modifier; confirm all labels disappear immediately.
24. **Shortcut tooltip — no flash on fast press** — Tap `Cmd+1` / `Ctrl+1` quickly (a normal shortcut activation). Confirm the first card becomes active and no tooltip label briefly appears on any card.
25. **Shortcut tooltip — clears on app switch** — With three cards, hold `Cmd` / `Ctrl` until labels appear. `Cmd+Tab` / `Alt+Tab` to another application and back. Confirm no labels are stuck after returning. Holding the modifier again must cause them to re-appear after 250 ms as normal.
26. **Shortcut tooltip — position 10+ excluded** — Add 10 or more cards, then hold `Cmd` / `Ctrl` until labels appear. Confirm exactly cards 1–9 show labels and card 10 (and any beyond it) shows none. Confirm card 10's content (slug, repo/branch row) is still rendered normally.

## CI

`.github/workflows/test.yml` defines three parallel jobs that run on every pull request and push to `main`:

| Job     | What it runs                                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check` | `pnpm lint`, `pnpm format:check`, `pnpm test` — lint, format, and unit/component tests                                                                                                                   |
| `e2e`   | `pnpm exec playwright install --with-deps chromium` then `pnpm exec playwright test` — Playwright specs against the Vite dev server (no Tauri binary required)                                           |
| `rust`  | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` and `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` — Clippy violations and formatting drift fail the build |

The `e2e` job runs the Vite frontend only; the `playwright.config.ts` `webServer` block starts `pnpm dev` automatically, so no native system dependencies beyond Node.js and Chromium are needed on the runner.

Branch protection rules should be configured to require both the `check` and `e2e` jobs before merging (follow-up item).

### Powerlevel10K / MesloLGS NF font verification

After `pnpm tauri dev` opens the app window, perform the following checks to confirm the font-loading integration and PTY locale are working correctly (issue #32).

1. **Font presence** — Open DevTools console and run `document.fonts.check('13px "MesloLGS NF"')`. It must return `true`. A `false` means `src/styles/fonts.css` is not being imported in `main.tsx`.
2. **Powerline glyph rendering** — If Powerlevel10k is installed in your shell, the prompt arrowheads must be flush against the preceding cell with no horizontal gap or boxed-question-mark placeholder. If p10k is not installed, run `printf '\xee\x82\xb0\n'` (a raw powerline right-arrow codepoint) and confirm it renders as a filled arrow, not a `?`.
3. **UTF-8 locale** — Run `echo $LC_ALL` inside the terminal. The output must contain `UTF-8`. Run `locale` and confirm `LC_CTYPE` also contains `UTF-8`.
4. **Non-ASCII characters** — Run `printf '\xe2\x98\x83\n'`. The snowman character ☃ must render correctly without corruption, confirming the PTY locale is in effect.
5. **Multi-tab consistency** — Open three cards in quick succession. Confirm all three terminals render the same MesloLGS NF glyphs (verifies the font is fully loaded before `term.open()` on each card, not just the first).

### OSC 7 / OSC 7337 verification

After `pnpm tauri dev` opens the app window, perform the following checks to confirm the OSC-based CWD and git context plumbing is working end-to-end.

1. **Status bar initial state** — Open the app and add a card. Confirm the status bar at the bottom of the panel shows `…` for the CWD while the shell prompt is initialising. After pressing Enter (or running any command) the status bar should update to the actual working directory (e.g. your home directory).
2. **CWD update on cd** — Run `cd /tmp` (or any non-git directory). Confirm the CWD in the status bar updates to `/tmp` and the git half of the status bar is empty.
3. **Git context appears on cd into a repo** — Run `cd` back into the ai-dungeon worktree directory. Confirm the right side of the status bar shows `ai-dungeon · feat/implement-osc7-based-solution` (or the current branch name).
4. **Detached HEAD display** — Inside any git repo, run `git checkout --detach HEAD`. Confirm the branch slot on the right shows the short commit hash (e.g. `ai-dungeon · a1b2c3d`) instead of failing or showing an empty string.
5. **Per-card independence** — Add a second card. Confirm each card's status bar tracks its own CWD and git context independently — running `cd /tmp` in card 1 must not change card 2's status bar.
6. **Context persists across tab switches** — Switch between tabs back and forth. Confirm the status bar values for each card are preserved across switches (keepMounted proof).
7. **Hook removal resilience** — In a single session, run `unset PROMPT_COMMAND; precmd_functions=()` (or the equivalent for your shell) to disable the hook. Confirm the status bar stops updating but does not crash. Close and reopen the card — confirm the hook is re-injected on the new PTY and the status bar starts updating again.
8. **Unborn-HEAD repository** — Run `mkdir /tmp/newrepo && cd /tmp/newrepo && git init`. Open a new card and navigate to that directory (`cd /tmp/newrepo`). Press Enter to trigger a prompt. Confirm the card shows no branch and no repo name (no stale git data). Then run `git commit --allow-empty -m init` and press Enter again. Confirm the branch (`main` or `master`, depending on your git default) now appears on the card.

## Rust Tests

The Rust backend (`src-tauri/`) is tested with standard `#[cfg(test)]` modules and `cargo test`.

```
cargo test --manifest-path src-tauri/Cargo.toml
```

Tests that exercise the PTY commands (`pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`) at the real PTY device boundary are deferred as future work — a real PTY is unavailable in most CI environments and non-trivial to mock at the `portable-pty` trait boundary.

The unit tests cover the session map/generation layer, the UTF-8 locale resolver, and the shell-startup injection module without spawning a real shell. All tests in `pty.rs::tests` are `#[serial]`-gated (via the `serial_test` crate) because the locale-resolver and injection tests mutate process-global env vars; serialisation prevents races between tests. Each such test also uses an `EnvGuard` RAII struct defined in the test module: `EnvGuard::set(key, value)` and `EnvGuard::remove(key)` save the current env-var value on construction and restore it in `Drop`, guaranteeing that a panicking assertion cannot leave the process environment dirty for subsequent tests.

| Test                                                              | What it covers                                                                                                                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pty_spawn_rejects_duplicate_session_id`                          | `try_reserve_session_id` returns `Err("session already exists: …")` on a duplicate sid and leaves the original reservation intact                                                      |
| `pty_kill_with_stale_generation_is_noop`                          | `pty_kill` with an old generation token is a no-op; the session at the newer generation survives                                                                                       |
| `pty_kill_with_matching_generation_removes_session`               | `pty_kill` with the matching generation removes the session                                                                                                                            |
| `pty_kill_with_none_generation_removes_session`                   | `pty_kill` with `None` removes the session unconditionally                                                                                                                             |
| `pty_kill_command_accepts_missing_generation_field`               | serde deserialises a JSON payload missing the `generation` key as `generation: None` (necessary — not sufficient — signal for Tauri IPC compatibility)                                 |
| `resolve_pty_utf8_locale_returns_lc_all_when_utf8`                | When `LC_ALL` is already a UTF-8 locale, the helper returns it unchanged (priority 1)                                                                                                  |
| `resolve_pty_utf8_locale_rejects_substring_utf8_in_lc_all`        | A value like `notUTF-8-locale` that contains "utf-8" as a substring but is not a real locale does not satisfy the UTF-8 check                                                          |
| `resolve_pty_utf8_locale_rejects_substring_utf8_in_lang`          | Same substring guard for `LANG`                                                                                                                                                        |
| `resolve_pty_utf8_locale_accepts_utf8_without_hyphen`             | Values using `UTF8` (no hyphen) are accepted as UTF-8 locales                                                                                                                          |
| `resolve_pty_utf8_locale_promotes_lang_when_lc_all_missing`       | When `LC_ALL` is unset, the helper promotes a UTF-8 `LANG` value (priority 2)                                                                                                          |
| `resolve_pty_utf8_locale_falls_back_to_platform_default`          | When neither `LC_ALL` nor `LANG` is a UTF-8 locale, the helper returns `en_US.UTF-8` (macOS) or `C.UTF-8` (other Unix)                                                                 |
| `shell_kind_classifies_zsh_bash_and_other`                        | `ShellKind::from_shell_path` returns `Zsh` for zsh paths, `Bash` for bash paths, and `Other` for all unrecognised shells (including `/bin/fish`, `/bin/sh`, empty string)              |
| `shell_injection_prepare_zsh_writes_zshrc`                        | `ShellInjection::prepare("/bin/zsh")` creates a `.zshrc` in the tempdir containing `__ai_dungeon_emit_ctx`, a `ZDOTDIR` restore clause, and source guards for `$HOME/.zshenv`/`.zshrc` |
| `shell_injection_prepare_bash_writes_init_file`                   | `ShellInjection::prepare("/bin/bash")` creates a `bash-init` file containing `__ai_dungeon_emit_ctx` and the `[ -r "$HOME/.bashrc" ]` source guard                                     |
| `shell_injection_prepare_other_is_noop`                           | `ShellInjection::prepare` for an unrecognised shell returns empty `extra_args` and `extra_env` (no-op injection)                                                                       |
| `shell_injection_zsh_args_and_env`                                | For zsh, `extra_args` is empty and `extra_env` contains exactly one entry `("ZDOTDIR", <tempdir>)`                                                                                     |
| `shell_injection_bash_args_and_env`                               | For bash, `extra_env` is empty and `extra_args` is exactly `["--rcfile", "<tempdir>/bash-init"]`                                                                                       |
| `shell_injection_zsh_script_restores_original_zdotdir`            | When `ZDOTDIR` is set, the generated `.zshrc` contains the base64-encoded original value and a `base64 -d` decode pattern                                                              |
| `shell_injection_zsh_script_unsets_zdotdir_when_original_absent`  | When `ZDOTDIR` is unset, the generated `.zshrc` contains an `unset ZDOTDIR` clause                                                                                                     |
| `polyglot_harness_emits_osc7_in_a_normal_directory`               | Sanity-check for the `capture_polyglot_output` test harness: runs the polyglot in a temp directory and asserts `\x1b]7;file://` is present in stdout                                   |
| `shell_init_polyglot_emits_cleared_osc_7337_when_branch_is_empty` | In a fresh `git init` repo with no commits (unborn HEAD), the polyglot emits a cleared OSC 7337 (`\x1b]7337;\x1b\\`) instead of a tab-delimited payload with an empty branch field     |
| `shell_init_polyglot_emits_osc7_only_once_when_cwd_is_unchanged`  | Calling `__ai_dungeon_emit_ctx` twice in the same directory emits OSC 7 exactly once (CWD-change debounce via `__ai_dungeon_last_cwd`)                                                 |
| `shell_init_polyglot_re_emits_osc7_after_cd`                      | After a `cd` between two prompt cycles, OSC 7 is emitted exactly twice (once per distinct CWD) and OSC 7337 is emitted exactly twice (once per prompt, no debounce)                    |
