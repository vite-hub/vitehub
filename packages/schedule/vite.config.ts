import { defineConfig } from "vite-plus";

import { normalizePackageExports, packDefaults } from "@vite-hub/internal/package-exports"

// Generated code imports these modules by path. They are not public API.
const privateEntries = new Set(["./definition", "./operations", "./runtime/console", "./runtime/state"]);

export default defineConfig({
  pack: {
    ...packDefaults,
    copy: [{ from: "src/registry-module.d.ts", to: "dist" }],
    deps: {
      alwaysBundle: [/^@vite-hub\/internal/],
      neverBundle: ["vite", "esbuild"],
      onlyBundle: false,
    },
    plugins: [{
      name: "schedule-registry-declarations",
      generateBundle(_options, bundle) {
        for (const fileName of ["index.d.ts", "runtime.d.ts"]) {
          const chunk = bundle[fileName]
          if (chunk?.type === "chunk") {
            chunk.code = `/// <reference path="./registry-module.d.ts" />\n${chunk.code}`
          }
        }
      },
    }],
    entry: [
      "src/definition.ts",
      "src/durability.ts",
      "src/index.ts",
      "src/operations.ts",
      "src/runtime.ts",
      "src/runtime/console.ts",
      "src/runtime/kv.ts",
      "src/runtime/process.ts",
      "src/runtime/state.ts",
      "src/runtime/static.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(Object.entries(exports).filter(([key]) => !privateEntries.has(key))));
      },
      inlinedDependencies: false,
    },
  },
});
