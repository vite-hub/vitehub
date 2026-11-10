import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [/^#vitehub\/browser\//, "@cloudflare/playwright", "esbuild", "playwright-core", "vite"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/internal/chromium.ts",
      "src/internal/chromium.workerd.ts",
      "src/internal/runtime/empty-registry.ts",
      "src/internal/runtime/unavailable.ts",
      "src/internal/runtime/unconfigured.ts",
      "src/controllers/cdp.ts",
      "src/controllers/playwright.ts",
      "src/providers/cloudflare.ts",
      "src/providers/local.ts",
      "src/vite.ts",
    ],
  },
})
