import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: ["@vitehub/queue/nitro"],
  queue: {
    provider: "cloudflare",
  },
})
