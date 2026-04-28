import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

import { DEFAULT_SETTINGS, type Settings } from "./types";

const VALID_COLOR_SCHEMES = new Set<string>(["light", "dark", "auto"]);

function isValidSettings(parsed: unknown): parsed is Settings {
  if (typeof parsed !== "object" || parsed === null) return false;
  const p = parsed as Record<string, unknown>;
  if (p["version"] !== 1) return false;
  if (typeof p["colorScheme"] !== "string" || !VALID_COLOR_SCHEMES.has(p["colorScheme"]))
    return false;
  const terminal = p["terminal"];
  if (typeof terminal !== "object" || terminal === null) return false;
  const t = terminal as Record<string, unknown>;
  if (typeof t["fontSize"] !== "number" || !isFinite(t["fontSize"]) || t["fontSize"] <= 0)
    return false;
  return true;
}

/**
 * Load settings from disk. Always returns a valid Settings object — never
 * throws. Falls back to DEFAULT_SETTINGS on any failure (missing file, parse
 * error, schema mismatch) and logs a console.warn describing the reason.
 */
export async function loadSettings(): Promise<Settings> {
  try {
    const fileExists = await exists("settings.json", { baseDir: BaseDirectory.AppConfig });
    if (!fileExists) {
      return DEFAULT_SETTINGS;
    }
    const raw = await readTextFile("settings.json", { baseDir: BaseDirectory.AppConfig });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[settings] Failed to parse settings.json — falling back to defaults.");
      return DEFAULT_SETTINGS;
    }
    if (!isValidSettings(parsed)) {
      console.warn(
        "[settings] settings.json has unexpected shape or wrong version — falling back to defaults.",
      );
      return DEFAULT_SETTINGS;
    }
    return parsed;
  } catch (err) {
    console.warn("[settings] Unexpected error loading settings — falling back to defaults.", err);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Persist settings to disk. Creates the app-config directory if needed
 * (idempotent via recursive: true), then writes the full settings object as
 * two-space-indented JSON so the file is human-editable.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  // Use "" (empty string) rather than "." as the path. "." resolves to
  // "…com.alkofu.ai-dungeon/." — a trailing-dot component that doesn't match the
  // `$APPCONFIG` whitelist in `fs:allow-mkdir`, so Tauri's scope checker rejects it.
  // "" resolves to the base directory itself, satisfying the scope check.
  await mkdir("", { baseDir: BaseDirectory.AppConfig, recursive: true });
  await writeTextFile("settings.json", JSON.stringify(settings, null, 2), {
    baseDir: BaseDirectory.AppConfig,
  });
}
