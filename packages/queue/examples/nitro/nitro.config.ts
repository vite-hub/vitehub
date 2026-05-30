import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: ["@vite-hub/queue/nitro"],
  queue: {
    provider: "cloudflare",
  },
})
