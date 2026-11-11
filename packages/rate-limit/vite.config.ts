import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["vite"],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: [
      "src/durability.ts",
      "src/index.ts",
      "src/cli.ts",
      "src/drivers/cloudflare.ts",
      "src/drivers/memory.ts",
      "src/operations.ts",
      "src/runtime.ts",
      "src/vite.ts",
    ],
    exports: {
      // Generated code imports these modules by path. They are not public API.
      exclude: ["cli", "operations"],
      customExports: normalizePackageExports,
      inlinedDependencies: false,
    },
  },
})
