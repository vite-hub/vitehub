import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vitehub\/internal/],
    neverBundle: ["#vitehub-workspace-assets-registry", "#vitehub-workspace-registry"],
  },
  dts: true,
  entry: [
    "src/ai.ts",
    "src/index.ts",
    "src/loader.ts",
    "src/nitro.ts",
    "src/publish.ts",
    "src/runtime/empty-assets-registry.ts",
    "src/runtime/empty-registry.ts",
    "src/runtime/assets.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/state.ts",
    "src/stores/cloudflare-artifacts.ts",
    "src/stores/vercel-blob.ts",
    "src/test.ts",
    "src/vite.ts",
  ],
  exports: {
    exclude: [
      "runtime/assets",
      "runtime/empty-assets-registry",
      "runtime/empty-registry",
      "runtime/nitro-plugin",
      "runtime/state",
      "stores/cloudflare-artifacts",
      "stores/vercel-blob",
    ],
    customExports(exports) {
      exports["./internal/runtime/assets"] = "./dist/runtime/assets.js"
      exports["./internal/runtime/empty-assets-registry"] =
        "./dist/runtime/empty-assets-registry.js"
      exports["./internal/runtime/empty-registry"] = "./dist/runtime/empty-registry.js"
      exports["./internal/runtime/nitro-plugin"] = "./dist/runtime/nitro-plugin.js"
      exports["./internal/runtime/state"] = "./dist/runtime/state.js"
      exports["./internal/stores/cloudflare-artifacts"] =
        "./dist/stores/cloudflare-artifacts.js"
      exports["./internal/stores/vercel-blob"] = "./dist/stores/vercel-blob.js"

      return exports
    },
    inlinedDependencies: false,
  },
  format: ["esm"],
  outExtensions: () => ({
    dts: ".d.ts",
    js: ".js",
  }),
  publint: true,
})
