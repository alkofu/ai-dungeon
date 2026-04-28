import "@mantine/core/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/fonts.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { App } from "./App";
import { SettingsProvider, useSettings } from "./settings/SettingsContext";

/**
 * MantineThemeBridge sits between SettingsProvider and MantineProvider so that
 * MantineProvider can receive the current colorScheme from settings without
 * being its own ancestor. Because SettingsProvider returns null until
 * loadSettings() resolves, MantineThemeBridge (and therefore MantineProvider)
 * are never mounted with DEFAULT_SETTINGS — the persisted color scheme is
 * applied on the very first paint.
 *
 * When colorScheme is "auto", forceColorScheme is omitted so Mantine falls
 * back to OS-level prefers-color-scheme detection.
 */
function MantineThemeBridge({ children }: { children: React.ReactNode }) {
  const { settings } = useSettings();
  const forceColorScheme = settings.colorScheme === "auto" ? undefined : settings.colorScheme;
  return <MantineProvider forceColorScheme={forceColorScheme}>{children}</MantineProvider>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <MantineThemeBridge>
        <App />
      </MantineThemeBridge>
    </SettingsProvider>
  </React.StrictMode>,
);
