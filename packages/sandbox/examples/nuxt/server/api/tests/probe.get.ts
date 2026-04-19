import { defineEventHandler } from 'h3'
import { useRuntimeConfig } from 'nitro/runtime-config'

export default defineEventHandler((event) => {
  const runtimeConfig = useRuntimeConfig() as {
    hosting?: string
    sandbox?: {
      provider?: string
    }
  }
  const preset = process.env.NITRO_PRESET || null
  const isCloudflare = event.req.runtime?.name === 'cloudflare'
    || !!event.context.cloudflare?.env
    || !!event.context._platform?.cloudflare?.env
  const provider = runtimeConfig.sandbox?.provider
    || process.env.SANDBOX_PROVIDER
    || (isCloudflare ? 'cloudflare' : null)
    || (process.env.VERCEL || process.env.VERCEL_URL ? 'vercel' : null)
  const hosting = runtimeConfig.hosting
    || preset
    || (isCloudflare ? 'cloudflare-module' : null)
    || (process.env.VERCEL || process.env.VERCEL_URL ? 'vercel' : null)

  return {
    ok: true,
    feature: 'sandbox',
    hosting,
    provider,
    runtime: event.req.runtime?.name || null,
    hasWaitUntil: typeof event.req.waitUntil === 'function',
  }
})
