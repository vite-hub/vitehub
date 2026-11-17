import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["@vite-hub/env", "@vite-hub/runtime", "drizzle-orm", "nostics", "valibot", "vite"],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/database.ts", "src/operations.ts", "src/runtime.ts", "src/vite.ts"],
  },
})
