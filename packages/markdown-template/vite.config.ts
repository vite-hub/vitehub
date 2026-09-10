import { defineConfig } from "vite-plus"

export default defineConfig({
  pack: {
    tsconfig: "tsconfig.build.json",
    deps: {
      neverBundle: ["comark"],
      onlyBundle: false,
    },
    entry: ["src/index.ts", "src/portable.ts", "src/internal/composition.ts"],
    exports: {
      customExports(exports) {
        exports["."] = { node: "./dist/index.js", types: "./dist/portable.d.ts", default: "./dist/portable.js" }
        delete exports["./portable"]
        return exports
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
