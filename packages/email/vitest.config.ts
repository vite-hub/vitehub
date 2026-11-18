import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub/email/definition": fileURLToPath(new URL("./src/runtime/empty-definition.ts", import.meta.url)),
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
