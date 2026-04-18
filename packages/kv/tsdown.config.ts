import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    onlyBundle: false,
    skipNodeModulesBundle: true,
  },
  copy: [
    { from: "src/virtual-module.d.ts", rename: "virtual.d.ts", to: "dist" },
  ],
  dts: true,
  entry: [
    "src/index.ts",
    "src/vite.ts",
    "src/nitro.ts",
    "src/nuxt.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/nitropack-plugin.ts",
    "src/runtime/nitropack-storage.ts",
    "src/virtual.ts",
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
