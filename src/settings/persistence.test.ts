import { afterEach, describe, expect, it, vi } from "vitest";
import { installFsMock } from "../test-utils/mockTauriFs";
import { DEFAULT_SETTINGS } from "./types";

// Import the mock helper at module level — the vi.mock factory inside
// mockTauriFs.ts runs before any imports resolve, which is required for
// Vitest's module mock hoisting to work correctly.
import "../test-utils/mockTauriFs";

const fsMock = installFsMock();

describe("loadSettings", () => {
  afterEach(() => {
    fsMock.reset();
  });

  it("returns DEFAULT_SETTINGS when file does not exist", async () => {
    // installFsMock with no initialFile → exists returns false
    const { loadSettings } = await import("./persistence");
    const result = await loadSettings();
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it("returns parsed settings when file exists with valid JSON", async () => {
    const saved = {
      version: 1 as const,
      colorScheme: "dark" as const,
      terminal: { fontSize: 16 },
    };
    installFsMock({ initialFile: JSON.stringify(saved) });
    // Re-import to pick up the new mock state (module is cached, but state is live)
    const { loadSettings } = await import("./persistence");
    const result = await loadSettings();
    expect(result).toEqual(saved);
  });

  it("returns DEFAULT_SETTINGS and warns when file has malformed JSON", async () => {
    installFsMock({ initialFile: "{ not valid json" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadSettings } = await import("./persistence");
    const result = await loadSettings();
    expect(result).toEqual(DEFAULT_SETTINGS);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns DEFAULT_SETTINGS and warns when file has valid JSON but wrong version", async () => {
    installFsMock({
      initialFile: JSON.stringify({ version: 2, colorScheme: "dark", terminal: { fontSize: 13 } }),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { loadSettings } = await import("./persistence");
    const result = await loadSettings();
    expect(result).toEqual(DEFAULT_SETTINGS);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("saveSettings", () => {
  afterEach(() => {
    fsMock.reset();
  });

  it("writes JSON-stringified settings via writeTextFile with BaseDirectory.AppConfig", async () => {
    const { saveSettings } = await import("./persistence");
    const { writeTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const settings = { ...DEFAULT_SETTINGS, colorScheme: "dark" as const };
    await saveSettings(settings);
    expect(writeTextFile).toHaveBeenCalledWith("settings.json", JSON.stringify(settings, null, 2), {
      baseDir: BaseDirectory.AppConfig,
    });
  });

  it('calls mkdir with "" (empty string) as the first arg before writeTextFile', async () => {
    const { saveSettings } = await import("./persistence");
    const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
    const mkdirMock = vi.mocked(mkdir);
    const writeTextFileMock = vi.mocked(writeTextFile);

    await saveSettings(DEFAULT_SETTINGS);

    expect(mkdirMock).toHaveBeenCalled();
    const mkdirFirstArg = mkdirMock.mock.calls[0][0];
    expect(mkdirFirstArg).toBe("");

    // mkdir must be called before writeTextFile
    const mkdirOrder = mkdirMock.mock.invocationCallOrder[0];
    const writeOrder = writeTextFileMock.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });

  it('does NOT call mkdir with "." (trailing-dot regression guard)', async () => {
    const { saveSettings } = await import("./persistence");
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    const mkdirMock = vi.mocked(mkdir);

    await saveSettings(DEFAULT_SETTINGS);

    const calls = mkdirMock.mock.calls;
    for (const call of calls) {
      expect(call[0]).not.toBe(".");
    }
  });
});
