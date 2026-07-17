import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    copy: [{ from: "src/registry-module.d.ts", rename: "registry.d.ts", to: "dist" }],
    deps: {
      neverBundle: ["vite"],
      alwaysBundle: [/^@vite-hub\/internal/],
      onlyBundle: false,
    },
    plugins: [{
      name: "rate-limit-registry-declarations",
      generateBundle(_options, bundle) {
        for (const fileName of ["index.d.ts", "runtime.d.ts"]) {
          const chunk = bundle[fileName]
          if (chunk?.type === "chunk") {
            chunk.code = `/// <reference path="./registry.d.ts" />\n${chunk.code}`
          }
        }
      },
    }],
    entry: [
      "src/index.ts",
      "src/drivers/cloudflare.ts",
      "src/drivers/memory.ts",
      "src/runtime.ts",
      "src/vite.ts",
    ],
    exports: {
      inlinedDependencies: false,
    },
    outExtensions: () => ({
      dts: ".d.ts",
      js: ".js",
    }),
    publint: true,
  },
})
