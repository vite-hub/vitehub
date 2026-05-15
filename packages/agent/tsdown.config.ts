import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vitehub\/internal/],
    neverBundle: ["#vitehub/agent/registry"],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/ai-sdk.ts",
    "src/index.ts",
    "src/cloudflare.ts",
    "src/nitro.ts",
    "src/runtime/empty-registry.ts",
    "src/runtime/nitro-runtime-config.ts",
    "src/tanstack-ai.ts",
    "src/test.ts",
    "src/vercel.ts",
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
