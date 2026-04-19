import { defineEventHandler } from "nitro/h3"
import { useRuntimeConfig } from "nitro/runtime-config"

export default defineEventHandler((event) => {
  const { hosting, kv } = useRuntimeConfig()
  return {
    feature: "kv",
    hasWaitUntil: typeof event.waitUntil === "function",
    hosting: hosting || null,
    ok: true,
    provider: (kv && typeof kv === "object" && "store" in kv ? kv.store.driver : null),
    runtime: hosting?.includes("cloudflare") ? "cloudflare" : "node",
  }
})
