import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

const preset = process.env.VITEHUB_PRESET === "netlify"
  ? "netlify"
  : process.env.VITEHUB_PRESET === "cloudflare"
    ? "cloudflare"
    : process.env.VITEHUB_PRESET === "vercel"
      ? "vercel"
      : "node"
const providerSandboxClosure = process.env.VITEHUB_PROVIDER_SANDBOX_CLOSURE === "1"

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  plugins: [vitehub({
    preset,
    auth: true,
    blob: preset === "cloudflare" || (preset === "vercel" && !providerSandboxClosure),
    database: true,
    queue: preset === "vercel" || preset === "cloudflare",
    rateLimit: preset === "node",
    schedule: true,
    ...(providerSandboxClosure
      ? {
          sandbox: preset === "vercel" || preset === "cloudflare",
        }
      : {
          agent: true,
          workflow: true,
          workspace: process.env.VITEHUB_CONSUMER_DISABLE_WORKSPACE !== "1",
        }),
  })],
})
