import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/runtime.ts", "src/workspace.ts"],
  exports: {
    inlinedDependencies: false,
  },
  format: ["esm"],
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  publint: true,
})
