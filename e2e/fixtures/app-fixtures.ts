/**
 * app-fixtures.ts
 *
 * Shared fixture module for all e2e specs in this project.
 *
 * Convention: shared helpers are expressed as Playwright `test.extend` fixtures
 * rather than page-object classes. Fixtures compose naturally with Playwright's
 * built-in lifecycle (setup/teardown, parallelism, worker reuse), are
 * parallel-safe by design, and avoid the stateful `this` coupling that
 * page-object classes introduce.
 *
 * Adding a new shared interaction: add a new fixture entry to the `fixtures`
 * object passed to `test.extend`, export nothing else from this file, and
 * import `{ test, expect }` from this module in every spec that needs it.
 *
 * NOTE: This file must NOT end in `.spec.ts`. Playwright's default test
 * discovery pattern matches `**\/*.spec.ts`; a non-spec name ensures this
 * module is treated as a plain TypeScript file and not executed as a test suite.
 */

import { test as base, expect, type Page } from "@playwright/test";

type AppFixtures = {
  /** Adds a terminal card via the "Add card menu" UI and waits for it to mount. */
  addTerminalCard: (page: Page) => Promise<void>;
};

export const test = base.extend<AppFixtures>({
  // eslint-disable-next-line no-empty-pattern
  addTerminalCard: async ({}, use) => {
    await use(async (page: Page) => {
      await page.getByRole("button", { name: "Add card menu" }).click();
      await page.getByRole("menuitem", { name: "Terminal" }).click();
      await page.waitForSelector('[data-testid="terminal-root"]');
    });
  },
});

export { expect };
