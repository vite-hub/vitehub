/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"
import { env } from "vite-hub/env"

export default defineConfig({
  plugins: [vitehub({
    database: true,
    email: { driver: "resend", options: { apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }) } },
    env: {
      server: {
        mailFrom: env({ source: env.source("MAIL_FROM") }),
      },
    },
    kv: true,
    host: "node",
    queue: true,
    schedule: true,
    workflow: true,
  })],
  test: { environment: "node" },
})
