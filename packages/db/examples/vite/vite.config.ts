import { resolve } from "node:path"
import { defineConfig } from "vite"

import { hubDb } from "@vitehub/db/vite"

export default defineConfig({
  appType: "custom",
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
    },
  },
  db: {
    connection: {
      authToken: process.env.TURSO_AUTH_TOKEN,
      url: process.env.TURSO_DATABASE_URL || "libsql://db.example.turso.io",
    },
    databases: {
      analytics: {
        connection: {
          authToken: process.env.TURSO_AUTH_TOKEN,
          url: process.env.TURSO_ANALYTICS_DATABASE_URL || "libsql://analytics.example.turso.io",
        },
      },
    },
  },
  plugins: [hubDb()],
})
