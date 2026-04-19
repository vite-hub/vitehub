import { defineEventHandler } from "h3"
import { useRuntimeConfig } from "nitro/runtime"

export default defineEventHandler((event) => {
  const { blob, hosting } = useRuntimeConfig(event) as {
    blob?: { provider?: { driver?: string } }
    hosting?: string
  }

  const isCloudflare = hosting === "cloudflare-module" || event.context?.cloudflare || event.context?._platform?.cloudflare
  let runtime = "node"
  if (isCloudflare) runtime = "cloudflare"
  else if (process.env.VERCEL) runtime = "vercel"

  return {
    feature: "blob",
    hasWaitUntil: typeof event.waitUntil === "function",
    hosting,
    ok: true,
    provider: blob?.provider?.driver,
    runtime,
  }
})
