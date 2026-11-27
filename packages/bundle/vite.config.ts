import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["vite"],
      alwaysBundle: [/^@vite-hub\/internal/, "vue-router"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/cli.ts", "src/operations.ts", "src/vite.ts"],
    exports: {
      ...packDefaults.exports,
      exclude: ["operations"],
    },
  },
})
