import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/vite.ts",
    "src/nitro.ts",
    "src/nuxt.ts",
    "src/runtime/nitro-plugin.ts",
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
