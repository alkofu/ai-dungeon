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

## Rust Tests (Future Work)

The Rust backend (`src-tauri/`) is currently a bare scaffold with no IPC commands. Once Rust commands are added, standard `#[cfg(test)]` modules and `cargo test` will be used. No additional Rust test dependencies are needed.
