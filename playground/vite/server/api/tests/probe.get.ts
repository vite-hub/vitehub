import { defineEventHandler, getQuery } from "h3"
import { useRuntimeConfig } from "nitro/runtime-config"

export default defineEventHandler((event) => {
  const runtimeConfig = useRuntimeConfig() as {
    hosting?: string
    kv?: { store?: { driver?: string } } | false
    sandbox?: { provider?: string } | false
    workflow?: { provider?: string } | false
  }
  const { kv } = runtimeConfig
  if (getQuery(event).sandbox) {
    const isCloudflare = event.req.runtime?.name === "cloudflare"
      || !!event.context.cloudflare?.env
      || !!event.context._platform?.cloudflare?.env
    const provider = (runtimeConfig.sandbox && typeof runtimeConfig.sandbox === "object" ? runtimeConfig.sandbox.provider : null)
      || (isCloudflare ? "cloudflare" : null)
      || (process.env.VERCEL || process.env.VERCEL_URL ? "vercel" : null)
    const hosting = runtimeConfig.hosting
      || process.env.NITRO_PRESET
      || (isCloudflare ? "cloudflare-module" : null)
      || (process.env.VERCEL || process.env.VERCEL_URL ? "vercel" : null)

    return {
      ok: true,
      feature: "sandbox",
      hasWaitUntil: typeof event.req.waitUntil === "function",
      hosting,
      provider,
      runtime: event.req.runtime?.name || null,
    }
  }

  if (getQuery(event).workflow) {
    const isCloudflare = event.req.runtime?.name === "cloudflare"
      || !!event.context.cloudflare?.env
      || !!event.context._platform?.cloudflare?.env
    const provider = (runtimeConfig.workflow && typeof runtimeConfig.workflow === "object" ? runtimeConfig.workflow.provider : null)
      || (isCloudflare ? "cloudflare" : null)
      || (process.env.VERCEL || process.env.VERCEL_URL ? "vercel" : null)
    const hosting = runtimeConfig.hosting
      || process.env.NITRO_PRESET
      || (isCloudflare ? "cloudflare-module" : null)
      || (process.env.VERCEL || process.env.VERCEL_URL ? "vercel" : null)

    return {
      ok: true,
      feature: "workflow",
      hasWaitUntil: typeof event.req.waitUntil === "function",
      hosting,
      provider,
      runtime: event.req.runtime?.name || null,
    }
  }

  return {
    ok: true,
    provider: (kv && typeof kv === "object" && "store" in kv ? kv.store.driver : null),
  }
})
