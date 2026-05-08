/**
 * smoke.spec.ts
 *
 * Intentionally minimal smoke test — serves as a copy-paste template for new
 * e2e authors. This spec asserts only that the app loads and renders its
 * initial empty state, establishing a baseline before any interaction.
 *
 * Template conventions for new specs:
 *   (a) Import `{ test, expect }` from `./fixtures/app-fixtures` — never from
 *       `@playwright/test` directly. The fixture module is the single source of
 *       truth for shared helpers and the extended test runner.
 *   (b) Call `await page.goto("/")` first in every test to ensure a clean
 *       navigation baseline.
 *   (c) Prefer `getByRole` / `getByTestId` over CSS selectors. Role-based and
 *       testid-based queries are resilient to style refactors and convey intent.
 *   (d) If you find yourself copy-pasting an interaction sequence (e.g., adding
 *       a card) into multiple specs, add it as a fixture in
 *       `e2e/fixtures/app-fixtures.ts` instead.
 */

import { test, expect } from "./fixtures/app-fixtures";

test.describe("smoke", () => {
  test("app loads at baseURL", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("main-empty-state")).toBeVisible();
  });
});
