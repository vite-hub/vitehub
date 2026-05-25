import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  copy: [
    { from: "src/registry-module.d.ts", to: "dist" },
  ],
  deps: {
    alwaysBundle: [/^@vitehub\/internal/],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/nitro.ts",
    "src/runtime.ts",
    "src/runtime/state.ts",
    "src/runtime/static.ts",
    "src/vite.ts",
  ],
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
