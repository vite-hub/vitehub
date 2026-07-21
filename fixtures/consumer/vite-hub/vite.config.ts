import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

const preset = process.env.VITEHUB_PRESET === "netlify"
  ? "netlify"
  : process.env.VITEHUB_PRESET === "vercel"
    ? "vercel"
    : "node"

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  plugins: [vitehub({
    preset,
    auth: true,
    queue: preset === "vercel",
    rateLimit: preset === "node",
    schedule: true,
    workspace: process.env.VITEHUB_CONSUMER_DISABLE_WORKSPACE === "1" ? false : undefined,
  })],
})
