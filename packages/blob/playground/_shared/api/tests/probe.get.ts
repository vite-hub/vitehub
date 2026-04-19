import { defineEventHandler } from "h3"
import { useRuntimeConfig } from "nitro/runtime-config"
import type { ResolvedBlobModuleOptions } from "../../../../src/types.ts"

type BlobGlobals = typeof globalThis & {
  __vitehubBlobConfig?: false | ResolvedBlobModuleOptions
  __vitehubBlobHosting?: string
}

type ProbeEvent = {
  context?: {
    cloudflare?: unknown
    nitro?: {
      runtimeConfig?: {
        blob?: false | ResolvedBlobModuleOptions
        hosting?: string
      }
    }
    _platform?: { cloudflare?: unknown }
  }
  waitUntil?: unknown
}

function detectRuntime(hosting: string | undefined, event: { context?: { cloudflare?: unknown, _platform?: { cloudflare?: unknown } } }): string {
  if (hosting?.includes("cloudflare") || event.context?.cloudflare || event.context?._platform?.cloudflare) return "cloudflare"
  if (hosting?.includes("vercel") || process.env.VERCEL) return "vercel"
  return "node"
}

function detectHosting(event: ProbeEvent): string | undefined {
  if (event.context?.cloudflare || event.context?._platform?.cloudflare) return "cloudflare-module"
  if (process.env.VERCEL) return "vercel"
}

function detectProvider(hosting: string | undefined): "cloudflare-r2" | "vercel-blob" | undefined {
  if (hosting?.includes("cloudflare")) return "cloudflare-r2"
  if (hosting?.includes("vercel")) return "vercel-blob"
}

export default defineEventHandler((event: ProbeEvent) => {
  const globals = globalThis as BlobGlobals
  const runtimeConfig = useRuntimeConfig(event as never) as {
    blob?: false | ResolvedBlobModuleOptions
    hosting?: string
  }
  const blob = runtimeConfig?.blob ?? globals.__vitehubBlobConfig
  const hosting = runtimeConfig?.hosting ?? globals.__vitehubBlobHosting ?? detectHosting(event)
  const provider = blob?.provider.driver ?? detectProvider(hosting)

  return {
    feature: "blob",
    hasWaitUntil: typeof event.waitUntil === "function",
    hosting: hosting || null,
    ok: true,
    provider: provider || null,
    runtime: detectRuntime(hosting, event),
  }
})
