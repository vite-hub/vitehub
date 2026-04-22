import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: ["@vitehub/queue/nitro", "@vitehub/kv/nitro"],
  queue: {},
  serverDir: "./server",
})
