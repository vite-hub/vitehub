import { defineEventHandler } from "h3"

function detectRuntime(
  event: {
    context?: { cloudflare?: unknown, _platform?: { cloudflare?: unknown } }
    req?: { runtime?: { cloudflare?: unknown } }
    runtime?: { cloudflare?: unknown }
  },
  hosting: string | undefined,
) {
  if (
    hosting === "cloudflare-module"
    || event.context?.cloudflare
    || event.context?._platform?.cloudflare
    || event.runtime?.cloudflare
    || event.req?.runtime?.cloudflare
  ) {
    return "cloudflare"
  }

  if (hosting?.includes("vercel") || process.env.VERCEL) return "vercel"
  return "node"
}

export default defineEventHandler((event) => {
  const hosting = (
    event.context?.cloudflare
    || event.context?._platform?.cloudflare
    || event.runtime?.cloudflare
    || event.req?.runtime?.cloudflare
    ? "cloudflare-module"
    : undefined
  )
    || (process.env.VERCEL ? "vercel" : undefined)
  const provider = hosting === "cloudflare-module"
    ? "cloudflare"
    : hosting === "vercel" ? "vercel" : undefined

  return {
    feature: "queue",
    hasWaitUntil: typeof event.waitUntil === "function",
    hosting,
    ok: true,
    provider,
    runtime: detectRuntime(event, hosting),
  }
})
