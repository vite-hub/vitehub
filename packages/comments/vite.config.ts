import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["nostics"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/client.ts", "src/database.ts", "src/database/postgres.ts", "src/operations.ts", "src/rpc.ts", "src/server.ts", "src/testing.ts", "src/vite.ts"],
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
