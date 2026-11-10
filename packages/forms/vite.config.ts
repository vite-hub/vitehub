import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["drizzle-orm", "nostics", "valibot", "vite"],
      alwaysBundle: [/^@vite-hub\/internal/, "strip-ansi"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/client.ts", "src/database.ts", "src/runtime.ts", "src/vite.ts", "src/operations.ts"],
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
