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
    "@vitehub/chat/nitro",
    "@vitehub/queue/nitro",
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
  chat: {
    cloudflare: { durableObjectState: false },
    dev: { initialize: false },
    provider: "nitro",
    webhook: false,
  },
  queue: {},
  sandbox: {},
  serverDir: "./server",
  workspace: {},
  workflow: {},
})
