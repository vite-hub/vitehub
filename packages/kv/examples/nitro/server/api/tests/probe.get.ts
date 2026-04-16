import { defineEventHandler } from "h3"
import { useRuntimeConfig } from "nitro/runtime"

export default defineEventHandler((event) => {
  const runtimeConfig = useRuntimeConfig() as {
    hosting?: string
    kv?: {
      driver?: string
      store?: {
        driver?: string
      }
    }
  }

  return {
    feature: "kv",
    hasWaitUntil: typeof event.waitUntil === "function"
      || typeof event.node?.req?.socket?.write === "function",
    hosting: runtimeConfig.hosting || null,
    ok: true,
    provider: runtimeConfig.kv?.store?.driver || runtimeConfig.kv?.driver || null,
    runtime: runtimeConfig.hosting?.includes("cloudflare") ? "cloudflare" : "node",
  }
})
