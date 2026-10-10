import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: {
    "#vitehub/connections/registry": fileURLToPath(new URL("./src/runtime/empty-registry.ts", import.meta.url)),
    "@vite-hub/internal": fileURLToPath(new URL("../internal/src", import.meta.url)),
    "@vite-hub/agent/env-identity": fileURLToPath(new URL("../agent/src/env-identity.ts", import.meta.url)),
    "@vite-hub/env": fileURLToPath(new URL("../env/src", import.meta.url)),
  } },
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
