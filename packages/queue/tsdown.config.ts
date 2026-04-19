import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    skipNodeModulesBundle: true,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/vite.ts",
    "src/nitro.ts",
    "src/nuxt.ts",
    "src/runtime/empty-registry.ts",
    "src/runtime/hosted.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/vercel-provider.ts",
    "src/runtime/vercel-provider-stub.ts",
  ],
  exports: true,
  format: ["esm"],
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  publint: true,
})
