import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  copy: [
    { from: "src/generated/registry.d.ts", to: "dist/generated" },
  ],
  deps: {
    alwaysBundle: [/^@vitehub\/internal/],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/nitro.ts",
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
