/**
 * Shared Vitest mock helper for @tauri-apps/plugin-fs.
 *
 * This is the ONLY place `vi.mock("@tauri-apps/plugin-fs")` should appear in
 * the test tree. All fs-touching tests must import `installFsMock` from here
 * rather than setting up their own ad-hoc mocks, so that mock implementations
 * never drift apart across test files.
 *
 * Usage (at the top level of a test file, outside describe blocks):
 *   import { installFsMock } from "../test-utils/mockTauriFs";
 *   const fsMock = installFsMock({ initialFile: '{"version":1,...}' });
 *   afterEach(() => fsMock.reset());
 */

import { vi } from "vitest";

// Mirror the real BaseDirectory enum values from @tauri-apps/plugin-fs.
// BaseDirectory.AppConfig === 13 in Tauri v2 JS (NOT 9, which is Public).
// Consumer code that imports BaseDirectory keeps working under this mock.
export const BaseDirectory = {
  Audio: 1,
  Cache: 2,
  Config: 3,
  Data: 4,
  LocalData: 5,
  Document: 6,
  Download: 7,
  Picture: 8,
  Public: 9,
  Video: 10,
  Resource: 11,
  Temp: 12,
  AppConfig: 13,
  AppData: 14,
  AppLocalData: 15,
  AppCache: 16,
  AppLog: 17,
  Desktop: 18,
  Executable: 19,
  Font: 20,
  Home: 21,
  Runtime: 22,
  Template: 23,
} as const;

// ---------------------------------------------------------------------------
// Internal mutable state (shared between the vi.mock factory and installFsMock)
// via a globalThis key so it survives module hoisting.
// ---------------------------------------------------------------------------
type FsMockInternalState = {
  initialFile: string | undefined;
  reads: number;
  writes: { path: string; contents: string }[];
};

const STATE_KEY = "__mockTauriFsState__";

function getState(): FsMockInternalState {
  if (!(STATE_KEY in globalThis)) {
    (globalThis as Record<string, unknown>)[STATE_KEY] = {
      initialFile: undefined,
      reads: 0,
      writes: [],
    } satisfies FsMockInternalState;
  }
  return (globalThis as Record<string, unknown>)[STATE_KEY] as FsMockInternalState;
}

// Initialise state immediately so the factory below can reference it.
getState();

vi.mock("@tauri-apps/plugin-fs", () => {
  const _BaseDirectory = {
    Audio: 1,
    Cache: 2,
    Config: 3,
    Data: 4,
    LocalData: 5,
    Document: 6,
    Download: 7,
    Picture: 8,
    Public: 9,
    Video: 10,
    Resource: 11,
    Temp: 12,
    AppConfig: 13,
    AppData: 14,
    AppLocalData: 15,
    AppCache: 16,
    AppLog: 17,
    Desktop: 18,
    Executable: 19,
    Font: 20,
    Home: 21,
    Runtime: 22,
    Template: 23,
  } as const;

  return {
    BaseDirectory: _BaseDirectory,

    exists: vi.fn(async (_path: string, _opts?: unknown): Promise<boolean> => {
      const s = (globalThis as Record<string, unknown>)[STATE_KEY] as FsMockInternalState;
      return s.initialFile !== undefined;
    }),

    readTextFile: vi.fn(async (_path: string, _opts?: unknown): Promise<string> => {
      const s = (globalThis as Record<string, unknown>)[STATE_KEY] as FsMockInternalState;
      s.reads += 1;
      if (s.initialFile !== undefined) {
        return s.initialFile;
      }
      throw new Error("File not found");
    }),

    writeTextFile: vi.fn(async (path: string, contents: string, _opts?: unknown): Promise<void> => {
      const s = (globalThis as Record<string, unknown>)[STATE_KEY] as FsMockInternalState;
      s.writes.push({ path, contents });
    }),

    mkdir: vi.fn(async (_path: string, _opts?: unknown): Promise<void> => {}),
  };
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FsMockHandle {
  readonly reads: number;
  readonly writes: { path: string; contents: string }[];
  reset(): void;
}

/**
 * Configure the shared fs mock for a test file. Call this at module level
 * (outside describe blocks) so it runs before any tests execute.
 *
 * @param options.initialFile - When provided, `exists` returns `true` and
 *   `readTextFile` returns this string. When absent, `exists` returns `false`.
 */
export function installFsMock({ initialFile }: { initialFile?: string } = {}): FsMockHandle {
  const s = getState();
  s.initialFile = initialFile;
  s.reads = 0;
  s.writes = [];

  return {
    get reads() {
      return getState().reads;
    },
    get writes() {
      return getState().writes;
    },
    reset() {
      const inner = getState();
      inner.initialFile = initialFile;
      inner.reads = 0;
      inner.writes = [];
      vi.clearAllMocks();
    },
  };
}
