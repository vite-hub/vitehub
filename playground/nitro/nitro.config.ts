import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { defineNitroConfig } from "nitro/config"

const require = createRequire(import.meta.url)
const aiGatewayShim = fileURLToPath(new URL("./shims/ai-sdk-gateway.ts", import.meta.url))
const vercelSandboxShim = fileURLToPath(new URL("./shims/vercel-sandbox.ts", import.meta.url))

const sandboxProvider = process.env.VITEHUB_SANDBOX_PROVIDER

export default defineNitroConfig({
  alias: {
    "async-retry": require.resolve("async-retry"),
    "picocolors": require.resolve("picocolors"),
    "xdg-portable": require.resolve("xdg-portable"),
    ...(sandboxProvider === "cloudflare"
      ? {
          "@ai-sdk/gateway": aiGatewayShim,
          "@vercel/sandbox": vercelSandboxShim,
        }
      : {}),
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
