import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#vitehub/email/definition": new URL("./src/runtime/empty-definition.ts", import.meta.url).pathname,
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
