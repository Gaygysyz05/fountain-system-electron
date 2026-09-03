import { resolve } from "path";
import { defineConfig } from "vitest/config";

// Separate from electron.vite.config.ts on purpose: that one defines THREE
// builds (main/preload/renderer), and electron-vite's own dev/build
// commands are what actually run them -- vitest just needs the renderer's
// `@renderer` alias to resolve imports the same way the app itself does,
// not electron-vite's multi-target build pipeline. Covers pure-logic
// modules (span-building, live position math, protocol helpers); no DOM
// environment configured since none of today's tests render a component --
// add `environment: "jsdom"` (and the jsdom devDependency) if that changes.
export default defineConfig({
  resolve: {
    alias: {
      "@renderer": resolve("src/renderer/src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
