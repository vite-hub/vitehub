import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

const node = process.env.CONSOLE_WEIGHT_HOST === "node"

export default defineConfig({
  build: { sourcemap: true },
  plugins: [
    vitehub({
      host: node ? "node" : "cloudflare",
      publicUrl: "https://console-weight.example.com",
      agent: true,
      logs: { source: "./server/logs.ts" },
      kv: true,
      database: node ? { migrateOnStart: true } : true,
      ...process.env.CONSOLE_WEIGHT_AUTH === "on" ? { auth: true } : {},
      ...process.env.CONSOLE_WEIGHT_CONSOLE === "on" ? { console: true } : {},
    }),
  ],
  nitro: { sourcemap: true },
})
