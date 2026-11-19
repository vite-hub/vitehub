import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["vue"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/vue.ts"],
  },
})
