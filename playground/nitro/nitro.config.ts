import { createRequire } from "node:module"

import { defineNitroConfig } from "nitro/config"

const require = createRequire(import.meta.url)

export default defineNitroConfig({
  alias: {
    "async-retry": require.resolve("async-retry"),
  },
  modules: [
    "@vitehub/env/nitro",
    "@vitehub/agent/nitro",
    "@vitehub/queue/nitro",
    "@vitehub/schedule/nitro",
    "@vitehub/kv/nitro",
    "@vitehub/blob/nitro",
    "@vitehub/sandbox/nitro",
    "@vitehub/workspace/nitro",
    "@vitehub/workflow/nitro",
  ],
  agent: {
    route: "/api/agents/[agent]",
  },
  blob: {},
  queue: {},
  schedule: {},
  sandbox: {},
  serverDir: "./server",
  vercel: {
    functions: {
      runtime: "nodejs22.x",
    },
  },
  workspace: {},
  workflow: {},
})
