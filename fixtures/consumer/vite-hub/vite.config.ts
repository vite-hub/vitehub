import { defineConfig } from "vite"
import { vitehub } from "vite-hub"
import { env } from "vite-hub/env"

const host = process.env.VITEHUB_HOST === "netlify"
  ? "netlify"
  : process.env.VITEHUB_HOST === "cloudflare"
    ? "cloudflare"
    : process.env.VITEHUB_HOST === "vercel"
      ? "vercel"
      : "node"
const providerSandboxClosure = process.env.VITEHUB_PROVIDER_SANDBOX_CLOSURE === "1"

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  plugins: [vitehub({
    host,
    auth: true,
    blob: host === "cloudflare" || (host === "vercel" && !providerSandboxClosure),
    database: true,
    email: {
      driver: "resend",
      options: {
        apiKey: env({ secret: true, source: env.source("RESEND_API_KEY") }),
      },
    },
    queue: host === "vercel" || host === "cloudflare",
    rateLimit: host === "node",
    schedule: host === "node" ? { runtime: { driver: "process" } } : true,
    ...(providerSandboxClosure
      ? {
          sandboxTask: host === "vercel" || host === "cloudflare",
        }
      : {
          agent: host === "netlify" ? { invocations: false } : true,
          // On Node the Agent turns Workflow on by itself and runs it inline. Turning it on here would need a provider.
          ...(host === "node" ? {} : { workflow: host !== "netlify" }),
          workspace: process.env.VITEHUB_CONSUMER_DISABLE_WORKSPACE !== "1",
        }),
  })],
})
