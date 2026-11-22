import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["advocaat", /^@ai-sdk\//],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: [
      "src/ai-sdk.ts",
      "src/index.ts",
      "src/internal.ts",
      "src/testing.ts",
    ],
  },
})
