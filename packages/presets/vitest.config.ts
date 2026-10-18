import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const agentSource = (path: string) => fileURLToPath(new URL(`../agent/src/${path}`, import.meta.url))

export default defineConfig({
  resolve: {
    // Tests run the presets against the Agent source, so a test can mock one Agent module for both.
    alias: [
      { find: /^@vite-hub\/agent$/, replacement: agentSource("index.ts") },
      { find: /^@vite-hub\/agent\/(.+)$/, replacement: agentSource("$1.ts") },
      { find: "@vite-hub/env", replacement: fileURLToPath(new URL("../env/src", import.meta.url)) },
      // The built package bundles forges, so `vi.mock("forges/<forge>")` reaches only the source.
      { find: "@vite-hub/forge", replacement: fileURLToPath(new URL("../forge/src/index.ts", import.meta.url)) },
      { find: "#vitehub/env/server", replacement: agentSource("../test/fixtures/server-env.ts") },
      { find: "#vitehub/agent/provider-agent", replacement: agentSource("provider-agent.ts") },
    ],
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
})
