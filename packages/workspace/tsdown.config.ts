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
    "src/assets.ts",
    "src/index.ts",
    "src/nitro.ts",
    "src/runtime/empty-assets-registry.ts",
    "src/runtime/empty-registry.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/state.ts",
    "src/stores/cloudflare-artifacts.ts",
    "src/stores/vercel-blob.ts",
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
