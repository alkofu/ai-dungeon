import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils/render";
import { App } from "./App";

// Mock xterm to avoid jsdom canvas/layout API issues
vi.mock("@xterm/xterm", () => {
  return {
    Terminal: vi.fn().mockImplementation(function () {
      return {
        write: vi.fn(),
        writeln: vi.fn(),
        open: vi.fn(),
        loadAddon: vi.fn(),
        dispose: vi.fn(),
      };
    }),
  };
});

vi.mock("@xterm/addon-fit", () => {
  return {
    FitAddon: vi.fn().mockImplementation(function () {
      return { fit: vi.fn() };
    }),
  };
});

describe("App", () => {
  it("renders the AppShell with terminal content", () => {
    renderWithProviders(<App />);
    expect(screen.getByTestId("terminal-root")).toBeInTheDocument();
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
