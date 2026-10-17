import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["vite"],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
      "src/cli.ts",
      "src/drivers/cloudflare.ts",
      "src/drivers/memory.ts",
      "src/runtime.ts",
      "src/runtime/console.ts",
      "src/vite.ts",
    ],
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
