import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    neverBundle: [
      "virtual:vitehub-sandbox-provider-loader",
      "virtual:vitehub-sandbox-registry",
    ],
    onlyBundle: false,
    skipNodeModulesBundle: true,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/vite.ts",
    "src/runtime/empty-registry.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/provider-loader.ts",
    "src/runtime/providers/cloudflare.ts",
    "src/runtime/providers/vercel.ts",
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
