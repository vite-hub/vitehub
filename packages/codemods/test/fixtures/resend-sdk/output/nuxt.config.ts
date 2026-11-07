import { env } from "vite-hub/env"

export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  vitehub: {
    preset: "node",
    email: {
      driver: "resend",
      options: { apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }) },
    },
  },
})
