import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    inputOptions: {
      onwarn(warning, warn) {
        if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message)
        warn(warning)
      },
    },
    deps: {
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
