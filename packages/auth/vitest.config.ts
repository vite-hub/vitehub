import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#app": new URL("./test/fixtures/nuxt-app.ts", import.meta.url).pathname,
      "#vitehub/auth/abilities": new URL("./src/runtime/empty-abilities.ts", import.meta.url).pathname,
      "#vitehub/auth/client": new URL("./src/runtime/empty-client.ts", import.meta.url).pathname,
      "#vitehub/auth/definition": new URL("./src/runtime/empty-definition.ts", import.meta.url).pathname,
      "#vitehub/auth/server": new URL("./src/internal/server.ts", import.meta.url).pathname,
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
