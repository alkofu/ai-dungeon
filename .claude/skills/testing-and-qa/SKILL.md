---
name: testing-and-qa
description: >
  Apply this skill when writing new tests, debugging failing tests, reviewing test coverage, adding CI steps, choosing a test strategy for new code, or any task that involves Vitest, Playwright, or cargo test in the ai-dungeon repository.
---

# Testing and QA

This skill covers the three test layers in the ai-dungeon repository: Vitest (unit and component), Playwright (E2E), and cargo test (Rust backend). Apply it whenever writing, running, or modifying tests.

## When to use this skill

- Writing a new test for any layer
- Debugging a failing test
- Reviewing test coverage for a feature
- Adding or modifying a CI job that runs tests
- Choosing which layer to test a new piece of code at

## Decision tree: which layer?

- **(a) Pure TypeScript function or reducer, no DOM** — Vitest unit test in `src/` with `.test.ts` suffix.
- **(b) React component using Mantine/context providers** — Vitest component test in `src/` with `.test.tsx` suffix, using `renderWithProviders` from `src/test-utils/render.tsx`.
- **(c) React component that renders `<Terminal />` or uses xterm.js directly** — same as (b), plus mock `@xterm/xterm` and `@xterm/addon-fit` at module level and pass an explicit `sessionId` prop (UUID string).
- **(d) React component rendering `Tabs.Tab`/`Tabs.List` (e.g., NavBar)** — wrap the component in a `<Tabs>` context in the test; see `NavBar.test.tsx`.
- **(e) Full user flow across multiple components or crossing the Tauri IPC boundary** — Playwright E2E test in `e2e/`.
- **(f) Rust function / PTY command in `src-tauri/`** — `cargo test` with `#[cfg(test)]`; currently deferred — see Current gaps.

## Vitest (unit and component)

Test files live in `src/` alongside the source file they test, using the `.test.ts` or `.test.tsx` suffix.

**Globals.** Vitest is configured with `globals: true` in `vite.config.ts`. `describe`, `it`, `vi`, `expect`, and `beforeEach` are available globally — do not import them.

**Minimal component test:**

```tsx
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test-utils/render";
import { MyComponent } from "./MyComponent";

describe("MyComponent", () => {
  it("renders the heading", () => {
    renderWithProviders(<MyComponent />);
    expect(screen.getByRole("heading", { name: /my component/i })).toBeInTheDocument();
  });
});
```

**Minimal pure-function test:**

```ts
import { add } from "./math";

describe("add", () => {
  it("returns the sum of two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});
```

**pnpm scripts:**

- `pnpm test` — run all Vitest tests once
- `pnpm test:watch` — run in watch mode
- `pnpm coverage` — run with coverage report

## Playwright (E2E)

Test files live in `e2e/` at the repo root, separate from `src/`.

`playwright.config.ts` auto-starts the Vite dev server on port 1420 and sets `baseURL: "http://localhost:1420"` — no manual `pnpm dev &` or `wait-on` is needed.

After a fresh `pnpm install`, install the browser: `npx playwright install chromium`.

**Minimal Playwright spec:**

```ts
import { test, expect } from "@playwright/test";

test("app loads the home page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeVisible();
});
```

**Runner:** `pnpm test:e2e`

## Rust (cargo test)

The Rust backend lives in `src-tauri/`. The four PTY commands (`pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`) are implemented in `src-tauri/src/pty.rs`.

Unit tests for these commands are currently deferred — a real PTY device is required and the `portable-pty` trait boundary is non-trivial to mock. See `TESTING.md#rust-tests-future-work`.

When Rust tests are added, use the standard inline module shape:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_works() {
        assert_eq!(2 + 2, 4);
    }
}
```

## Current gaps

| Gap                              | Status   | Note                                                                                                                         |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| E2E test files in `e2e/`         | none     | directory exists but is empty; no specs written yet                                                                          |
| Playwright CI job                | missing  | `.github/workflows/test.yml` runs lint/format/unit only; see "Adding a Playwright CI job" below for a ready-to-paste snippet |
| Rust unit tests for PTY commands | deferred | requires real PTY device; see `TESTING.md#rust-tests-future-work`                                                            |

## Reference exemplars

- `src/App.test.tsx` — pure-function reducer tests in a dedicated `describe("appReducer")` block, no DOM
- `src/components/Terminal/Terminal.test.tsx` — module-level mocks of `@xterm/xterm` and `@xterm/addon-fit`, per-test `ResizeObserver` override, explicit `sessionId` prop pattern
- `src/components/layout/NavBar.test.tsx` — wrapping a component that uses `Tabs.Tab`/`Tabs.List` in a `<Tabs>` context in the test

## Adding a Playwright CI job (snippet)

The snippet below matches the conventions of the existing `check` job in `.github/workflows/test.yml`. No `pnpm dev &` or `npx wait-on` is needed — `playwright.config.ts` handles dev-server startup via `webServer`.

```yaml
e2e:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version-file: .node-version
        cache: pnpm
    - run: pnpm install --frozen-lockfile
    - run: npx playwright install --with-deps chromium
    - run: pnpm test:e2e
```

## See also

- `TESTING.md#testing-architecture` — overall test architecture overview
- `TESTING.md#unit-and-component-tests-vitest` — Vitest setup and configuration details
- `TESTING.md#renderwithproviders` — how `renderWithProviders` is implemented and when to use it
- `TESTING.md#jsdom-stubs-for-xtermjs` — operational detail on the canvas and ResizeObserver stubs and why xterm.js is mocked at the module level
- `TESTING.md#testing-appreducer-directly` — pattern for testing the app reducer in isolation
- `TESTING.md#e2e-tests-playwright` — Playwright configuration and usage
- `TESTING.md#manual-pty-verification` — how to manually verify PTY behaviour without automated tests
- `TESTING.md#ci` — what the current CI pipeline covers
- `TESTING.md#rust-tests-future-work` — plan for adding Rust unit tests when PTY mocking is feasible
