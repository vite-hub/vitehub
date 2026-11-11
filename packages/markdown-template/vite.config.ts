import { defineConfig } from "vite-plus"

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    ...packDefaults,
    deps: {
      neverBundle: ["comark", "vite"],
      onlyBundle: false,
      alwaysBundle: [/^@vite-hub\/internal/],
    },
    entry: ["src/index.ts", "src/portable.ts", "src/file.ts", "src/internal/composition.ts", "src/internal/vite.ts", "src/vite.ts"],
    exports: {
      customExports(exports) {
        exports["."] = {
          types: { node: "./dist/index.d.ts", default: "./dist/portable.d.ts" },
          node: "./dist/index.js",
          default: "./dist/portable.js",
        }
        delete exports["./portable"]
        return normalizePackageExports(exports)
      },
      inlinedDependencies: false,
    },
  },
})
