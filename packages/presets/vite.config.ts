import { fileURLToPath } from "node:url"

import { defineConfig } from "vite-plus"

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

import { presetsBuildRevision } from "./src/internal/build-revision.ts"

export default defineConfig({
  pack: {
    define: { __VITEHUB_PRESETS_BUILD_REVISION__: JSON.stringify(presetsBuildRevision(fileURLToPath(new URL(".", import.meta.url)))) },
    tsconfig: "tsconfig.build.json",
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: [/^@vite-hub\/agent(?:\/|$)/],
      onlyBundle: false,
    },
    entry: [
      "src/babysitter.ts",
      "src/babysitter/server.ts",
      "src/labeller.ts",
      "src/workspace.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(exports)
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
