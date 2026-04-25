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
    renderNavBar(<NavBar cards={[]} onAddCard={vi.fn()} onRemoveCard={vi.fn()} />);

    expect(screen.getByText("No cards yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove card/i })).toBeNull();
  });

  it("renders provided cards with remove buttons", () => {
    renderNavBar(
      <NavBar cards={[{ id: "a" }, { id: "b" }]} onAddCard={vi.fn()} onRemoveCard={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Remove card a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove card b" })).toBeInTheDocument();
  });

  it("calls onAddCard when the Add card button is clicked", async () => {
    const onAddCard = vi.fn();
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(<NavBar cards={[]} onAddCard={onAddCard} onRemoveCard={onRemoveCard} />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(onAddCard).toHaveBeenCalledTimes(1);
    expect(onRemoveCard).not.toHaveBeenCalled();
  });

  it("calls onRemoveCard with the correct id when a close button is clicked", async () => {
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderNavBar(
      <NavBar cards={[{ id: "a" }, { id: "b" }]} onAddCard={vi.fn()} onRemoveCard={onRemoveCard} />,
    );

    await user.click(screen.getByRole("button", { name: "Remove card a" }));

    expect(onRemoveCard).toHaveBeenCalledTimes(1);
    expect(onRemoveCard).toHaveBeenCalledWith("a");
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
        <NavBar cards={[{ id: "a" }]} onAddCard={vi.fn()} onRemoveCard={onRemoveCard} />
      </Tabs>,
    );

    await user.click(screen.getByRole("button", { name: "Remove card a" }));

    // onRemoveCard fires once, but the Tabs onChange handler must NOT be called.
    expect(onRemoveCard).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
