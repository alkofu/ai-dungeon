import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { Tabs } from "@mantine/core";
import { renderWithProviders } from "../../test-utils/render";
import { NavBar } from "./NavBar";

// SHORTCUT_GLYPH in SessionCard.tsx is a module-level constant evaluated at
// import time. Mock isMacPlatform to return true so the constant is "⌘" in
// every test in this file (no test here expects "Ctrl+").
vi.mock("./useModifierHeld", async (importOriginal) => {
  const original = await importOriginal<typeof import("./useModifierHeld")>();
  return { ...original, isMacPlatform: () => true };
});
import type { ReactElement } from "react";

// NavBar now renders Tabs.List and Tabs.Tab which require a Tabs ancestor for
// context. Wrap each render in a vertical Tabs container.
function renderNavBar(ui: ReactElement) {
  return renderWithProviders(
    <Tabs value={null} onChange={() => {}} orientation="vertical">
      {ui}
    </Tabs>,
  );
}

function makeCards(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `card-${String(i + 1)}`,
    type: "terminal" as const,
  }));
}

describe("NavBar", () => {
  it("renders empty state when no cards are provided", () => {
    renderNavBar(
      <NavBar
        cards={[]}
        onAddTerminalCard={vi.fn()}
        onAddDungeonCard={vi.fn()}
        onRemoveCard={vi.fn()}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    expect(screen.getByText("No cards yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove card/i })).toBeNull();
  });

  it("renders provided cards with remove buttons", () => {
    renderNavBar(
      <NavBar
        cards={[
          { id: "abcdefgh-1234-5678-abcd-ef1234567890", type: "terminal" },
          { id: "12345678", type: "terminal" },
        ]}
        onAddTerminalCard={vi.fn()}
        onAddDungeonCard={vi.fn()}
        onRemoveCard={vi.fn()}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    // Use a full UUID so slice(0, 8) is actually exercised
    expect(screen.getByRole("button", { name: "Remove card abcdefgh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove card 12345678" })).toBeInTheDocument();
  });

  it("clicking the trigger then the Terminal item calls onAddTerminalCard", async () => {
    const onAddTerminalCard = vi.fn();
    const onAddDungeonCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar
        cards={[]}
        onAddTerminalCard={onAddTerminalCard}
        onAddDungeonCard={onAddDungeonCard}
        onRemoveCard={vi.fn()}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    expect(onAddTerminalCard).toHaveBeenCalledTimes(1);
    expect(onAddDungeonCard).not.toHaveBeenCalled();
  });

  it("clicking the trigger then the Dungeon item calls onAddDungeonCard", async () => {
    const onAddTerminalCard = vi.fn();
    const onAddDungeonCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar
        cards={[]}
        onAddTerminalCard={onAddTerminalCard}
        onAddDungeonCard={onAddDungeonCard}
        onRemoveCard={vi.fn()}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Dungeon" }));

    expect(onAddDungeonCard).toHaveBeenCalledTimes(1);
    expect(onAddTerminalCard).not.toHaveBeenCalled();
  });

  it("opening the menu and pressing ArrowDown then Enter activates the first item (Terminal)", async () => {
    const onAddTerminalCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar
        cards={[]}
        onAddTerminalCard={onAddTerminalCard}
        onAddDungeonCard={vi.fn()}
        onRemoveCard={vi.fn()}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add card menu" }));
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onAddTerminalCard).toHaveBeenCalledTimes(1);
  });

  it("calls onRemoveCard with the correct id when a close button is clicked", async () => {
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar
        cards={[
          { id: "a", type: "terminal" },
          { id: "b", type: "terminal" },
        ]}
        onAddTerminalCard={vi.fn()}
        onAddDungeonCard={vi.fn()}
        onRemoveCard={onRemoveCard}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove card a" }));

    expect(onRemoveCard).toHaveBeenCalledTimes(1);
    expect(onRemoveCard).toHaveBeenCalledWith("a");
  });

  it("calls onRemoveCard when Enter is pressed on the close button (keyboard a11y)", async () => {
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar
        cards={[{ id: "a", type: "terminal" }]}
        onAddTerminalCard={vi.fn()}
        onAddDungeonCard={vi.fn()}
        onRemoveCard={onRemoveCard}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    const closeButton = screen.getByRole("button", { name: "Remove card a" });
    closeButton.focus();
    await user.keyboard("{Enter}");

    expect(onRemoveCard).toHaveBeenCalledTimes(1);
    expect(onRemoveCard).toHaveBeenCalledWith("a");
  });

  it("calls onRemoveCard when Space is pressed on the close button (keyboard a11y)", async () => {
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar
        cards={[{ id: "a", type: "terminal" }]}
        onAddTerminalCard={vi.fn()}
        onAddDungeonCard={vi.fn()}
        onRemoveCard={onRemoveCard}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    const closeButton = screen.getByRole("button", { name: "Remove card a" });
    closeButton.focus();
    await user.keyboard(" ");

    expect(onRemoveCard).toHaveBeenCalledTimes(1);
    expect(onRemoveCard).toHaveBeenCalledWith("a");
  });

  // This test is a style-application guard, not a behavioural overflow test. The JSDOM test
  // environment in `src/test-utils/setup.ts` does not import `@mantine/core/styles.css`, so
  // `getComputedStyle` reflects only inline styles. The test verifies that the JSX statically
  // applies the required style declarations; it cannot detect future regressions where overflow
  // re-appears via a different mechanism (e.g., a child element whose own width pushes past the
  // constraint).
  //
  // Behavioural validation (no horizontal overflow with realistic content) is performed manually
  // in Step 4 and is the load-bearing safeguard. A future Playwright end-to-end test is recorded
  // as a follow-up but is out of scope for this fix.
  //
  // The assertion that `w="100%"` resolves to inline `style={{ width: "100%" }}` is correct in
  // Mantine v9 (verified by Truthhammer against the installed version) but the resolution chain
  // is a Mantine implementation detail and could theoretically change in a future major version.
  // If Mantine is upgraded across a major version boundary, re-verify this assertion.
  it("applies width and overflow style declarations to Tabs.Tab so SessionCard does not overflow the navbar", () => {
    renderNavBar(
      <NavBar
        cards={[{ id: "abcdefgh-1234-5678-abcd-ef1234567890", type: "terminal" }]}
        onAddTerminalCard={vi.fn()}
        onAddDungeonCard={vi.fn()}
        onRemoveCard={vi.fn()}
        sessionContext={{}}
        shellContext={{}}
      />,
    );

    const tab = screen.getByRole("tab");

    expect(tab).toHaveStyle({ overflow: "hidden" });
    expect(tab).toHaveStyle({ whiteSpace: "normal" });
    expect(tab).toHaveStyle({ display: "block" });
    expect(tab).toHaveStyle({ width: "100%" });

    const innerSpan = tab.querySelector(":scope > span");
    expect(innerSpan).not.toBeNull();
    expect(innerSpan).toHaveStyle({ width: "100%" });
    expect(innerSpan).toHaveStyle({ textAlign: "left" });
    expect(innerSpan).toHaveStyle({ whiteSpace: "normal" });
  });

  // ── Shortcut tooltip overlay tests ───────────────────────────────────────────

  describe("shortcut tooltip overlay via modifierPressed prop", () => {
    it("3 cards + modifierPressed=true: DOM contains ⌘1, ⌘2, ⌘3", () => {
      renderNavBar(
        <NavBar
          cards={makeCards(3)}
          onAddTerminalCard={vi.fn()}
          onAddDungeonCard={vi.fn()}
          onRemoveCard={vi.fn()}
          sessionContext={{}}
          shellContext={{}}
          modifierPressed={true}
        />,
      );

      // Tooltips use withinPortal={true}, so labels appear in document.body portal.
      // Use document-scoped screen.getByText (not within(navbar)) to find them.
      expect(screen.getByText("⌘1")).toBeInTheDocument();
      expect(screen.getByText("⌘2")).toBeInTheDocument();
      expect(screen.getByText("⌘3")).toBeInTheDocument();
    });

    it("3 cards + modifierPressed=false: no ⌘N text in DOM", () => {
      renderNavBar(
        <NavBar
          cards={makeCards(3)}
          onAddTerminalCard={vi.fn()}
          onAddDungeonCard={vi.fn()}
          onRemoveCard={vi.fn()}
          sessionContext={{}}
          shellContext={{}}
          modifierPressed={false}
        />,
      );

      expect(screen.queryByText("⌘1")).toBeNull();
      expect(screen.queryByText("⌘2")).toBeNull();
      expect(screen.queryByText("⌘3")).toBeNull();
    });

    it("11 cards + modifierPressed=true: ⌘1–⌘9 present, ⌘10 absent; card 10 remove button still in DOM", () => {
      renderNavBar(
        <NavBar
          cards={makeCards(11)}
          onAddTerminalCard={vi.fn()}
          onAddDungeonCard={vi.fn()}
          onRemoveCard={vi.fn()}
          sessionContext={{}}
          shellContext={{}}
          modifierPressed={true}
        />,
      );

      // Cards 1–9 get tooltips
      for (let i = 1; i <= 9; i++) {
        expect(screen.getByText(`⌘${String(i)}`)).toBeInTheDocument();
      }

      // Card 10 does NOT get a tooltip (position > 9 guard)
      expect(screen.queryByText("⌘10")).toBeNull();

      // Card 10 itself is still rendered — only the overlay is suppressed
      expect(screen.getByRole("button", { name: /Remove card card-10/i })).toBeInTheDocument();
    });
  });

  it("does NOT trigger the tab onChange when the close button is clicked (stopPropagation)", async () => {
    // This test verifies that event.stopPropagation() on the CloseButton prevents
    // the click from bubbling to the Tabs.Tab and activating it before removal.
    // If stopPropagation() were removed, the onChange spy would be called when
    // clicking the close button.
    const onChange = vi.fn();
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <Tabs value={null} onChange={onChange} orientation="vertical">
        <NavBar
          cards={[{ id: "a", type: "terminal" }]}
          onAddTerminalCard={vi.fn()}
          onAddDungeonCard={vi.fn()}
          onRemoveCard={onRemoveCard}
          sessionContext={{}}
          shellContext={{}}
        />
      </Tabs>,
    );

    await user.click(screen.getByRole("button", { name: "Remove card a" }));

    // onRemoveCard fires once, but the Tabs onChange handler must NOT be called.
    expect(onRemoveCard).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
