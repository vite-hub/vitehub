/// <reference types="vitest/config" />
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"
import { env } from "vite-hub/env"

export default defineConfig(({ mode }) => ({
  plugins: [{
    // `#app-mode` is the mode that Vite resolved this config in. Vitest and `vite-hub/test/register` use `test`.
    load: id => id === "\0app-mode" ? `export default ${JSON.stringify(mode)}` : undefined,
    name: "app-mode",
    resolveId: id => id === "#app-mode" ? "\0app-mode" : undefined,
  }, vitehub({
    auth: true,
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
  test: { environment: "node", include: ["test/*.test.ts"] },
}))
