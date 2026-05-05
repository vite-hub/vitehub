import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-workspace-assets-registry": new URL("src/runtime/empty-assets-registry.ts", import.meta.url).pathname,
      "#vitehub-workspace-registry": new URL("src/runtime/empty-registry.ts", import.meta.url).pathname,
      "@vitehub/sandbox/runtime/state": new URL("../sandbox/src/runtime/state.ts", import.meta.url).pathname,
      "@vitehub/sandbox": new URL("../sandbox/src/index.ts", import.meta.url).pathname,
      "virtual:vitehub-sandbox-provider-loader": new URL("../sandbox/src/runtime/provider-loader.ts", import.meta.url).pathname,
      "virtual:vitehub-sandbox-registry": new URL("../sandbox/src/runtime/empty-registry.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
