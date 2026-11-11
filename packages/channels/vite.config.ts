import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["#vitehub/channels/registry", "vite"],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/runtime/empty-registry.ts",
      "src/server.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(
          Object.entries(exports).filter(([key]) => key !== "./runtime/empty-registry"),
        ))
      },
      inlinedDependencies: false,
    },
  },
})
