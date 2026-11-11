import { defineConfig } from "vite-plus"

import { packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["@formisch/vue", "drizzle-orm", "nostics", "valibot", "vite", "vue"],
      alwaysBundle: [/^@vite-hub\/internal/, "strip-ansi"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/client.ts", "src/database.ts", "src/guard.ts", "src/runtime.ts", "src/vite.ts", "src/operations.ts", "src/vue.ts"],
  },
})
