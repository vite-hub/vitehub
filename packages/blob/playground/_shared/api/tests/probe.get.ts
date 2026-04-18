import { defineEventHandler } from "h3"
import { useRuntimeConfig } from "nitro/runtime"

export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event) as {
    blob?: {
      provider?: {
        driver?: string
      }
    }
    hosting?: string
  }
  const runtime = config.hosting === "cloudflare-module" || event.context?.cloudflare || event.context?._platform?.cloudflare
    ? "cloudflare"
    : process.env.VERCEL ? "vercel" : "node"

  return {
    feature: "blob",
    hasWaitUntil: typeof event.waitUntil === "function",
    hosting: config.hosting,
    ok: true,
    provider: config.blob?.provider?.driver,
    runtime,
  }
})
