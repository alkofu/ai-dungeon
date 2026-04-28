import { MantineProvider } from "@mantine/core";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";

export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, {
    // env="test" tells Mantine's Transition component to bypass animation timers,
    // rendering content immediately when mounted=true. Without this, Mantine Modal
    // content is not accessible via RTL queries in jsdom until the transition completes.
    wrapper: ({ children }) => <MantineProvider env="test">{children}</MantineProvider>,
    ...options,
  });
}
