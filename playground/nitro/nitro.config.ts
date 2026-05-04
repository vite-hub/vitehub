import { createRequire } from "node:module"

import { defineNitroConfig } from "nitro/config"

const require = createRequire(import.meta.url)

export default defineNitroConfig({
  alias: {
    "async-retry": require.resolve("async-retry"),
  },
  modules: [
    "@vitehub/queue/nitro",
    "@vitehub/kv/nitro",
    "@vitehub/blob/nitro",
    "@vitehub/sandbox/nitro",
    "@vitehub/workspace/nitro",
    "@vitehub/workflow/nitro",
  ],
  blob: {},
  queue: {},
  sandbox: {},
  serverDir: "./server",
  workflow: {},
})
