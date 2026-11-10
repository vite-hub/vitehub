import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["@formisch/vue", "drizzle-orm", "nostics", "valibot", "vite", "vue"],
      alwaysBundle: [/^@vite-hub\/internal/, "strip-ansi"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/client.ts", "src/database.ts", "src/guard.ts", "src/runtime.ts", "src/vite.ts", "src/operations.ts", "src/vue.ts"],
    exports: {
      customExports: normalizePackageExports,
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
