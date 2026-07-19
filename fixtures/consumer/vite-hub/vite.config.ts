import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  plugins: [vitehub({
    auth: true,
    blob: true,
    rateLimit: { provider: "memory" },
    schedule: true,
    workflow: true,
    workspace: process.env.VITEHUB_CONSUMER_DISABLE_WORKSPACE === "1" ? false : undefined,
  })],
})
