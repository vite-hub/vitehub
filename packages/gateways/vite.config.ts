import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      // Optional peers: ask() loads advocaat and languageModel() loads its AI SDK provider on first use.
      neverBundle: ["advocaat", /^@ai-sdk\//],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: [
      "src/ai-sdk.ts",
      "src/index.ts",
      "src/internal.ts",
    ],
  },
})
