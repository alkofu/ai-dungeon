import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { Tabs } from "@mantine/core";
import { renderWithProviders } from "../../test-utils/render";
import { NavBar } from "./NavBar";
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

describe("NavBar", () => {
  it("renders empty state when no cards are provided", () => {
    renderNavBar(<NavBar cards={[]} onAddCard={vi.fn()} onRemoveCard={vi.fn()} sessionMeta={{}} />);

    expect(screen.getByText("No cards yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove card/i })).toBeNull();
  });

  it("renders provided cards with remove buttons", () => {
    renderNavBar(
      <NavBar
        cards={[{ id: "abcdefgh-1234-5678-abcd-ef1234567890" }, { id: "12345678" }]}
        onAddCard={vi.fn()}
        onRemoveCard={vi.fn()}
        sessionMeta={{}}
      />,
    );

    // Use a full UUID so slice(0, 8) is actually exercised
    expect(screen.getByRole("button", { name: "Remove card abcdefgh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove card 12345678" })).toBeInTheDocument();
  });

  it("calls onAddCard when the Add card button is clicked", async () => {
    const onAddCard = vi.fn();
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar cards={[]} onAddCard={onAddCard} onRemoveCard={onRemoveCard} sessionMeta={{}} />,
    );

    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(onAddCard).toHaveBeenCalledTimes(1);
    expect(onRemoveCard).not.toHaveBeenCalled();
  });

  it("calls onRemoveCard with the correct id when a close button is clicked", async () => {
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar
        cards={[{ id: "a" }, { id: "b" }]}
        onAddCard={vi.fn()}
        onRemoveCard={onRemoveCard}
        sessionMeta={{}}
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
        cards={[{ id: "a" }]}
        onAddCard={vi.fn()}
        onRemoveCard={onRemoveCard}
        sessionMeta={{}}
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
        cards={[{ id: "a" }]}
        onAddCard={vi.fn()}
        onRemoveCard={onRemoveCard}
        sessionMeta={{}}
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
        cards={[{ id: "abcdefgh-1234-5678-abcd-ef1234567890" }]}
        onAddCard={vi.fn()}
        onRemoveCard={vi.fn()}
        sessionMeta={{}}
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
          cards={[{ id: "a" }]}
          onAddCard={vi.fn()}
          onRemoveCard={onRemoveCard}
          sessionMeta={{}}
        />
      </Tabs>,
    );

    await user.click(screen.getByRole("button", { name: "Remove card a" }));

    // onRemoveCard fires once, but the Tabs onChange handler must NOT be called.
    expect(onRemoveCard).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
