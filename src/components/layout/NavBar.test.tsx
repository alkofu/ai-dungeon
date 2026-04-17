import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { renderWithProviders } from "../../test-utils/render";
import { NavBar } from "./NavBar";

describe("NavBar", () => {
  it("renders empty state when no cards are provided", () => {
    renderWithProviders(<NavBar cards={[]} onAddCard={vi.fn()} onRemoveCard={vi.fn()} />);

    expect(screen.getByText("No cards yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove card/i })).toBeNull();
  });

  it("renders provided cards with remove buttons", () => {
    renderWithProviders(
      <NavBar cards={[{ id: "a" }, { id: "b" }]} onAddCard={vi.fn()} onRemoveCard={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: "Remove card a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove card b" })).toBeInTheDocument();
  });

  it("calls onAddCard when the Add card button is clicked", async () => {
    const onAddCard = vi.fn();
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<NavBar cards={[]} onAddCard={onAddCard} onRemoveCard={onRemoveCard} />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(onAddCard).toHaveBeenCalledTimes(1);
    expect(onRemoveCard).not.toHaveBeenCalled();
  });

  it("calls onRemoveCard with the correct id when a close button is clicked", async () => {
    const onRemoveCard = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <NavBar cards={[{ id: "a" }, { id: "b" }]} onAddCard={vi.fn()} onRemoveCard={onRemoveCard} />,
    );

    await user.click(screen.getByRole("button", { name: "Remove card a" }));

    expect(onRemoveCard).toHaveBeenCalledTimes(1);
    expect(onRemoveCard).toHaveBeenCalledWith("a");
  });
});
