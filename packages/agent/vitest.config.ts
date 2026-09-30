import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // Tests load and mock the provider Driver source instead of the package import's built output.
      "#vitehub/agent/provider-agent": fileURLToPath(new URL("./src/provider-agent.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: ["test/output/**", "test/local/**"],
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
})
