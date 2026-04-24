import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: ["@vitehub/queue/nitro", "@vitehub/kv/nitro", "@vitehub/sandbox/nitro"],
  queue: {},
  sandbox: {},
  serverDir: "./server",
})
