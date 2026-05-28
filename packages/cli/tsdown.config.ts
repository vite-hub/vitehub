import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vitehub\/internal/],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
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
