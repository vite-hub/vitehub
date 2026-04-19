import { resolve } from "node:path"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub-queue-registry": resolve(import.meta.dirname, "src/runtime/empty-registry.ts"),
      "#vitehub-queue-vercel-provider": resolve(import.meta.dirname, "src/runtime/vercel-provider.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
