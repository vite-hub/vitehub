import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["vite"],
      // Keep offline reports usable without Vue or the other router runtime peers.
      alwaysBundle: [/^@vite-hub\/internal/, "vue-router"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/cli.ts", "src/vite.ts"],
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
