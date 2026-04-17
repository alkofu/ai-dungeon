import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils/render";
import App from "./App";

describe("App", () => {
  it("renders the heading and description", () => {
    renderWithProviders(<App />);

    // AppLayout renders an <Title order={3}> ("AI Dungeon") in the header and
    // App renders an <h1> ("AI Dungeon") in the main content area — both contain
    // the same text. Target the <h1> specifically by role + level to avoid
    // getByText ambiguity between the two "AI Dungeon" nodes.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("AI Dungeon");
    expect(
      screen.getByText("Multi-workspace terminal for AI agents and CLIs."),
    ).toBeInTheDocument();
  });

  it("adds and removes a card via the navbar", async () => {
    const user = userEvent.setup();
    renderWithProviders(<App />);

    await user.click(screen.getByRole("button", { name: "Add card" }));

    const removeButton = screen.getByRole("button", { name: /Remove card/i });
    expect(removeButton).toBeInTheDocument();

    await user.click(removeButton);

    expect(screen.queryByRole("button", { name: /Remove card/i })).toBeNull();
  });
});
