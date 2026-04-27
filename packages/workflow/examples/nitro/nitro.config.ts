import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: ["@vitehub/workflow/nitro"],
  workflow: {
    provider: "cloudflare",
  },
})
