import { env } from "vite-hub/env"

export default defineNuxtConfig({
  modules: ["vite-hub/nuxt"],
  runtimeConfig: {
    resendApiKey: process.env.MAIL_KEY,
  },
  vitehub: {
    host: "node",
    email: {
      driver: "resend",
      options: { apiKey: env({ secret: true, source: env.source(["RESEND_API_KEY", "NUXT_RESEND_API_KEY", "MAIL_KEY"]) }) },
    },
  },
})
