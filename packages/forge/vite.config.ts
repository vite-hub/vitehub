import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    inputOptions: {
      onwarn(warning, warn) {
        // A missing bundled dependency would leave an unusable published package.
        if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message)
        warn(warning)
      },
    },
    deps: {
      // forges is only on pkg.pr.new, so the published manifest must not name it.
      alwaysBundle: [/^@vite-hub\/internal/, /^forges(?:\/|$)/],
      onlyBundle: false,
    },
    entry: [
      "src/index.ts",
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
