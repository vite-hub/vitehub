import { createRequire } from "node:module"

import { defineNitroConfig } from "nitro/config"

const require = createRequire(import.meta.url)
const cloudflareSandboxName = process.env.VITEHUB_CLOUDFLARE_SANDBOX_NAME

export default defineNitroConfig({
  alias: {
    "async-retry": require.resolve("async-retry"),
  },
  modules: [
    "@vite-hub/env/nitro",
    "@vite-hub/agent/nitro",
    "@vite-hub/queue/nitro",
    "@vite-hub/schedule/nitro",
    "@vite-hub/kv/nitro",
    "@vite-hub/blob/nitro",
    "@vite-hub/sandbox/nitro",
    "@vite-hub/workspace/nitro",
    "@vite-hub/workflow/nitro",
  ],
  agent: {
    route: "/api/agents/[agent]",
  },
  blob: {},
  queue: {},
  schedule: {},
  sandbox: cloudflareSandboxName ? { name: cloudflareSandboxName } : {},
  serverDir: "./server",
  vercel: {
    functions: {
      runtime: "nodejs22.x",
    },
  },
  workspace: {},
  workflow: {},
})
