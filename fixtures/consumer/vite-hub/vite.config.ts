import { defineConfig } from "vite"
import { vitehub } from "vite-hub"
import { env } from "vite-hub/env"

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
    email: {
      driver: "unemail/driver/resend",
      options: {
        apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }),
      },
    },
    queue: preset === "vercel" || preset === "cloudflare",
    rateLimit: preset === "node",
    schedule: true,
    ...(providerSandboxClosure
      ? {
          sandbox: preset === "vercel" || preset === "cloudflare",
        }
      : {
          agent: true,
          workflow: preset === "netlify" ? false : true,
          workspace: process.env.VITEHUB_CONSUMER_DISABLE_WORKSPACE !== "1",
        }),
  })],
})
