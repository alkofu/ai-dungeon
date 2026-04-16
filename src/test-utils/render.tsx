import { MantineProvider } from "@mantine/core";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";

export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, {
    wrapper: ({ children }) => <MantineProvider>{children}</MantineProvider>,
    ...options,
  });
}
