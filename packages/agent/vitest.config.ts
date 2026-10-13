import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

// CI splits these serial test files across jobs with `<index>/<count>`.
// Vitest reads `shard` from the resolved config, but its config type only
// declares the CLI option, so the value is spread in.
const shard = process.env.VITEHUB_TEST_SHARD || undefined

export default defineConfig({
  resolve: {
    alias: {
      "@vite-hub/agent/env-identity": fileURLToPath(new URL("../agent/src/env-identity.ts", import.meta.url)),
      "@vite-hub/env": fileURLToPath(new URL("../env/src", import.meta.url)),
      "#vitehub/env/server": fileURLToPath(new URL("./test/fixtures/server-env.ts", import.meta.url)),
      // Tests load and mock the provider Driver source instead of the package import's built output.
      "#vitehub/agent/provider-agent": fileURLToPath(new URL("./src/provider-agent.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: ["test/output/**", "test/local/**"],
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
    ...shard ? { shard } : {},
  },
})
