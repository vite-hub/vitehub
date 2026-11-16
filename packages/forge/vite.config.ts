import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    inputOptions: {
      onwarn(warning, warn) {
        // A missing bundled dependency would leave an unusable published package.
        if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message)
        warn(warning)
      },
    },
    deps: {
      // forges is only on pkg.pr.new, so the published manifest must not name it.
      alwaysBundle: [/^@vite-hub\/internal/, /^forges(?:\/|$)/],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/build.ts",
      "src/build/node.ts",
    ],
  },
})
