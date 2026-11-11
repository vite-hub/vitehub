import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/cli.ts"],
    exports: {
      customExports(exports) {
        delete exports["./cli"]
        return normalizePackageExports(exports)
      },
      bin: {
        "vitehub-codemods": "src/cli.ts",
      },
      inlinedDependencies: false,
    },
  },
})
