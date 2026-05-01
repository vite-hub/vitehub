import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
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
  workspace: {},
  workflow: {},
})
