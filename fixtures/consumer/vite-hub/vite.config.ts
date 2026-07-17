import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  plugins: [vitehub({
    auth: true,
    rateLimit: { provider: "memory" },
    schedule: true,
    workspace: process.env.VITEHUB_CONSUMER_DISABLE_WORKSPACE === "1" ? false : undefined,
  })],
})
