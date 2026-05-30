import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: [
      "#vitehub-sandbox-provider-loader",
      "#vitehub-sandbox-registry",
      "@vite-hub/sandbox/runtime/provider-loader",
      "vitehub-sandbox-provider-loader",
      "virtual:vitehub-sandbox-provider-loader",
    ],
    onlyBundle: false,
    skipNodeModulesBundle: true,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/nitro.ts",
    "src/vite.ts",
    "src/runtime/empty-registry.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/provider-loader.ts",
    "src/runtime/providers/cloudflare.ts",
    "src/runtime/providers/vercel.ts",
    "src/runtime/state.ts",
    "src/sandbox/providers/cloudflare.ts",
    "src/sandbox/providers/vercel.ts",
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
