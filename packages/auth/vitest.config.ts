import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "#app": fileURLToPath(new URL("./test/fixtures/nuxt-app.ts", import.meta.url)),
      "#vitehub/auth/abilities": fileURLToPath(new URL("./src/runtime/empty-abilities.ts", import.meta.url)),
      "#vitehub/auth/client": fileURLToPath(new URL("./src/runtime/empty-client.ts", import.meta.url)),
      "#vitehub/auth/definition": fileURLToPath(new URL("./src/runtime/empty-definition.ts", import.meta.url)),
      "#vitehub/auth/server": fileURLToPath(new URL("./src/internal/server.ts", import.meta.url)),
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
