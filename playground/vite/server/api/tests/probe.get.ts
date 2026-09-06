import { defineEventHandler, getQuery } from "h3"

export default defineEventHandler((event) => {
  if (getQuery(event).sandbox) {
    const isCloudflare = event.req.runtime?.name === "cloudflare"
      || !!event.context.cloudflare?.env
      || !!event.context._platform?.cloudflare?.env
    const isVercel = !!(process.env.VERCEL || process.env.VERCEL_URL)
    const provider = isCloudflare ? "cloudflare" : isVercel ? "vercel" : null
    const hosting = process.env.VITEHUB_HOSTING
      || (isCloudflare ? "cloudflare-module" : isVercel ? "vercel" : null)

    return {
      ok: true,
      feature: "sandbox",
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The request adapter is a runtime boundary, and callability is the capability contract.
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
