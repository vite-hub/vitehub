import { defineConfig } from "tsdown"

export default defineConfig({
  clean: true,
  deps: {
    alwaysBundle: [/^@vite-hub\/internal/],
    neverBundle: ["#vitehub/workflow/registry"],
    onlyBundle: false,
  },
  dts: true,
  entry: [
    "src/index.ts",
    "src/vite.ts",
    "src/runtime/cloudflare-runner.ts",
    "src/runtime/cloudflare-vite.ts",
    "src/runtime/cloudflare-shared.ts",
    "src/runtime/execute.ts",
    "src/runtime/openworkflow.ts",
    "src/runtime/openworkflow-worker.ts",
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
