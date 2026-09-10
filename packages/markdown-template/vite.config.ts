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
        exports["."] = { types: "./dist/index.d.ts", node: "./dist/index.js", default: "./dist/portable.js" }
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
