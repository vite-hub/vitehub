import { defineEventHandler, getQuery } from "h3"

export default defineEventHandler((event) => {
  if (getQuery(event).sandbox) {
    const isCloudflare = event.req.runtime?.name === "cloudflare"
      || !!event.context.cloudflare?.env
      || !!event.context._platform?.cloudflare?.env
    const provider = isCloudflare ? "cloudflare" : null
      || (process.env.VERCEL || process.env.VERCEL_URL ? "vercel" : null)
    const hosting = process.env.VITEHUB_HOSTING
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

  return {
    ok: true,
    provider: null,
  }
})
