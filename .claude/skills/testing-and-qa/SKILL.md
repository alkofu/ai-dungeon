---
name: testing-and-qa
description: >
  Apply this skill when writing new tests, debugging failing tests, reviewing test coverage, adding CI steps, choosing a test strategy for new code, or any task that involves Vitest, Playwright, or cargo test in the ai-dungeon repository.
---

# Testing and QA

This skill covers the three test layers in the ai-dungeon repository: Vitest (unit and component), Playwright (E2E), and cargo test (Rust backend). Apply it whenever writing, running, or modifying tests.

## When to use this skill

Apply this skill any time you write, run, modify, or review a test, or decide which layer to add coverage at. For deciding _what_ and _where_ to test, follow the Test selection procedure below.

## Test selection procedure

1. Identify what type of behaviour is under test: pure logic, component rendering, UI integration, or Rust-only.
2. Choose the lowest layer that can prove the behaviour with confidence.
3. Prefer Vitest over Playwright unless the behaviour requires multi-component flow, browser APIs, or real frontend-backend integration.
4. Avoid duplicating the same assertion across layers unless each layer covers a distinct risk.

## Decision tree: which layer?

- **(a) Pure TypeScript function or reducer, no DOM** — Vitest unit test in `src/` with `.test.ts` suffix. (validates deterministic logic in isolation — pure functions, no runtime)
- **(b) React component using Mantine/context providers** — Vitest component test in `src/` with `.test.tsx` suffix, using `renderWithProviders` from `src/test-utils/render.tsx`. (validates component rendering and local user interaction under Mantine providers)
- **(c) React component that renders `<Terminal />` or uses xterm.js directly** — same as (b), plus mock `@xterm/xterm` and `@xterm/addon-fit` at module level and pass an explicit `sessionId` prop (UUID string). (validates the xterm-backed component without booting a real xterm instance — mocked at module level)
- **(d) React component rendering `Tabs.Tab`/`Tabs.List` (e.g., NavBar)** — wrap the component in a `<Tabs>` context in the test; see `NavBar.test.tsx`. (validates Mantine compound-component wiring inside a Tabs context)
- **(e) Full user flow across multiple components** — Playwright E2E test in `e2e/`. (validates end-user UI flow in a real browser; `invoke()` is unavailable — Tauri runtime is absent in this setup)
- **(f) Rust function / PTY command in `src-tauri/`** — `cargo test` with `#[cfg(test)]`; PTY-command tests are currently deferred in this repo because the implementation is hard to isolate at the `portable-pty` boundary. Revisit if PTY logic is extracted behind a mockable abstraction. See Current gaps. (validates Rust logic without Tauri overhead, when the PTY boundary is mockable)

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

**If a test fails, check:**

- missing provider — did you use `renderWithProviders` from `src/test-utils/render.tsx` instead of bare `render`?
- missing DOM API stub — does the component need `matchMedia`, canvas, or `ResizeObserver`?
- stale mock — for mock-heavy files (see `Terminal.test.tsx`), is `vi.clearAllMocks()` called in `beforeEach`?
- unresolved async assertion — did you `await` the `userEvent` interaction?

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

**If a test fails, check:**

- dev server not ready — does the test use `page.goto("/")` so `webServer` boots Vite automatically?
- selector brittleness — can a role-based query (`getByRole`) replace a text-content selector?
- race condition — is the assertion `await expect(...)` rather than a synchronous expect?
- `invoke()` in a Playwright test — the Tauri runtime is absent; these calls will fail silently.

## Rust (cargo test)

The Rust backend lives in `src-tauri/`. The four PTY commands (`pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`) are implemented in `src-tauri/src/pty.rs`.

PTY-command tests are deferred in this repo today because a real PTY device is needed and the `portable-pty` trait boundary is non-trivial to mock. This is a current repo-state observation, not a prohibition — revisit once PTY logic is extracted behind a mockable abstraction. See `TESTING.md#rust-tests-future-work`.

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

**If a test fails, check:**

- missing test-only dependency — is the crate listed under `[dev-dependencies]` in `src-tauri/Cargo.toml`?
- visibility — is the function or module `pub` (or `pub(crate)`) enough for the `#[cfg(test)]` module to reach it?
- fixture or state setup — did you initialise required state before the assertion?
- platform-specific assertion — avoid assertions that depend on host OS behaviour on CI runners.

## Output expectations

When applying this skill, produce the following:

- the chosen test layer and the reason for that choice (referencing the decision tree branch);
- the file path of the new or modified test file;
- any required mocks, providers, or fixtures (e.g. `renderWithProviders`, module-level `@xterm/xterm` mock);
- the exact `pnpm` command to run the test (`pnpm test`, `pnpm test:watch`, `pnpm test:e2e`, or `cargo test --manifest-path src-tauri/Cargo.toml`);
- any coverage gaps or follow-up tests identified.

## Anti-patterns

Avoid the following in this repo:

- Do not use Playwright for logic that Vitest can cover (pure functions, reducers, component rendering).
- Do not call `render` directly — always use `renderWithProviders` from `src/test-utils/render.tsx` for Mantine components.
- Do not write per-test `@xterm/xterm` mocks — mock at the module level (see `src/components/Terminal/Terminal.test.tsx`).
- Do not hardcode `http://localhost:1420` in Playwright tests — rely on `baseURL` via `page.goto("/")`.
- Do not duplicate reducer or pure-logic coverage through UI or E2E tests unless the wiring itself is under test.
- Do not use brittle text-content selectors when role-based or testid queries are available.

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

When writing a new test, prefer matching the nearest exemplar in style and setup before inventing a new harness.

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
