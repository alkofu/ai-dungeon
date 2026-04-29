import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // 600 kB (~30% above the current 456 KB synchronous initial chunk) is
    // appropriate for a Tauri desktop app where the bundle is loaded from
    // the embedded WebView's local filesystem. The default 500 kB threshold
    // is calibrated for HTTP-delivered web apps. Raised to 600 kB to give
    // headroom for incremental dependency growth while still catching
    // meaningful regressions.
    chunkSizeWarningLimit: 600,
  },

  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./src/test-utils/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      exclude: ["src/main.tsx", "src/vite-env.d.ts", "src/test-utils/**"],
    },
  },

  optimizeDeps: {
    include: ["@xterm/xterm", "@xterm/addon-fit"],
    // Workaround: @tabler/icons-react causes Vite dev-server chunk explosion (~23k pre-bundled chunks). Exclude from optimizeDeps. Production builds are unaffected.
    exclude: ["@tabler/icons-react"],
  },
});
