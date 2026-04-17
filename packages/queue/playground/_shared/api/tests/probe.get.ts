import { defineEventHandler } from "h3"
import { useRuntimeConfig } from "nitro/runtime"

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const queue = config.queue && typeof config.queue === "object" ? config.queue : undefined
  const provider = queue?.provider?.provider
  const runtime = config.hosting === "cloudflare-module" || event.context?.cloudflare || event.context?._platform?.cloudflare
    ? "cloudflare"
    : process.env.VERCEL ? "vercel" : "node"

  return {
    feature: "queue",
    hasWaitUntil: typeof event.waitUntil === "function",
    hosting: config.hosting,
    ok: true,
    provider,
    runtime,
  }
})
