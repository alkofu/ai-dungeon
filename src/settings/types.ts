export interface Settings {
  version: 1;
  colorScheme: "light" | "dark" | "auto";
  terminal: { fontSize: number };
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  colorScheme: "auto",
  terminal: { fontSize: 13 },
};
