import { defineConfig } from "vite-plus";

import { normalizePackageExports } from "@vite-hub/internal/package-exports"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
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
      "src/cli.ts",
      "src/definition.ts",
      "src/index.ts",
      "src/nuxt.ts",
      "src/runtime.ts",
      "src/runtime/console.ts",
      "src/runtime/dev.ts",
      "src/runtime/driver.ts",
      "src/runtime/kv.ts",
      "src/runtime/process.ts",
      "src/runtime/state.ts",
      "src/runtime/static.ts",
      "src/vite.ts",
    ],
    exports: {
      customExports(exports) {
        return normalizePackageExports(Object.fromEntries(Object.entries(exports).filter(([key]) => key !== "./definition")));
      },
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
});
