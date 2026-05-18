import { createRequire } from "node:module"

import { defineNitroConfig } from "nitro/config"

const require = createRequire(import.meta.url)

const sandboxProvider = process.env.VITEHUB_SANDBOX_PROVIDER

export default defineNitroConfig({
  alias: {
    "async-retry": require.resolve("async-retry"),
    "picocolors": require.resolve("picocolors"),
    "xdg-portable": require.resolve("xdg-portable"),
  },
  modules: [
    "@vitehub/env/nitro",
    "@vitehub/agent/nitro",
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
  queue: {},
  sandbox: sandboxProvider === "cloudflare" || sandboxProvider === "vercel"
    ? { provider: sandboxProvider }
    : {},
  serverDir: "./server",
  workspace: {},
  workflow: {},
})
