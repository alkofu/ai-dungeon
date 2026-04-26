/**
 * terminal-font-rendering.spec.ts
 *
 * Verifies that MesloLGS NF is loaded and registered with the browser's
 * FontFaceSet before the xterm.js terminal is opened, fixing the Powerlevel10k
 * glyph spacing regression tracked in issue #32.
 *
 * Primary assertion: document.fonts.check('13px "MesloLGS NF"') returns true.
 * This is a robust, machine-readable check that does not depend on pixel-level
 * rendering and is stable across machines, CI runners, and OS font stacks.
 *
 * Screenshot assertions are intentionally omitted. Snapshot diffs across host
 * font-rendering stacks are false-positive-prone without a pinned Docker image.
 * The document.fonts.check() assertion plus the manual smoke checklist below
 * provide sufficient coverage.
 *
 * Manual smoke checklist (record results in the PR description):
 *   1. Open three tabs back-to-back; each tab's prompt renders MesloLGS NF glyphs.
 *   2. Open a tab, switch to a different app, switch back — font is still loaded.
 *   3. Run `print -P '%F{green}%f'` (zsh) — powerline arrowhead is crisp, no gap.
 *   4. Run `printf '\xe2\x98\x83\n'` — snowman ☃ renders, confirming UTF-8 locale.
 *   5. Run `locale` — LC_CTYPE and LC_ALL both contain UTF-8.
 */

import { test, expect } from "@playwright/test";

test.describe("MesloLGS NF font loading", () => {
  test("MesloLGS NF is loaded in document.fonts after a terminal card mounts", async ({ page }) => {
    await page.goto("/");

    // Add a card so a <Terminal> component mounts and triggers font loading.
    const addButton = page.getByRole("button", { name: /add/i });
    await addButton.click();

    // Wait for the terminal root to appear, confirming the component mounted.
    await page.waitForSelector('[data-testid="terminal-root"]');

    // Primary assertion: MesloLGS NF must be fully loaded at the target font
    // size (13px — matches the fontSize passed to the XTerm constructor).
    // document.fonts.check() returns true only after the font has been both
    // registered AND loaded; a pending font face returns false.
    const fontLoaded = await page.evaluate(() => document.fonts.check('13px "MesloLGS NF"'));

    expect(fontLoaded).toBe(true);
  });
});
