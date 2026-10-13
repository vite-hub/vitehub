import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: {
      "@vite-hub/runtime/internal/grant": fileURLToPath(new URL("../runtime/src/internal/grant.ts", import.meta.url)),
      "@vite-hub/agent/env-identity": fileURLToPath(new URL("../agent/src/env-identity.ts", import.meta.url)),
      "@vite-hub/env": fileURLToPath(new URL("../env/src", import.meta.url)),
  } },
  test: {
    include: ["test/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["test/**/*.test-d.ts"],
    },
  },
})
