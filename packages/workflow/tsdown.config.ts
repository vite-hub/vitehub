import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vitehub\/internal/],
    neverBundle: ["#vitehub/workflow/registry"],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/nitro.ts",
    "src/vite.ts",
    "src/runtime/cloudflare-runner.ts",
    "src/runtime/cloudflare-vite.ts",
    "src/runtime/cloudflare-shared.ts",
    "src/runtime/nitro-plugin.ts",
    "src/runtime/state.ts",
    "src/runtime/vercel-vite.ts",
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
