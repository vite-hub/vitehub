import { fileURLToPath } from "node:url"

import { defineConfig, mergeConfig } from "vitest/config"

import { nodeAndTypeTests } from "../../vitest.shared.ts"

export default mergeConfig(nodeAndTypeTests, defineConfig({
  resolve: {
    alias: {
      "#vitehub/queue/node-client": fileURLToPath(new URL("./src/internal/runtime/postgres-client.ts", import.meta.url)),
    },
  },
}))
