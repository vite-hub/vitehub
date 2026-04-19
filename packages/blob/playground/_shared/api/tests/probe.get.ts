import { defineEventHandler } from "h3"
import { useRuntimeConfig } from "nitro/runtime-config"
import type { ResolvedBlobModuleOptions } from "../../../src/types.ts"

type BlobGlobals = typeof globalThis & {
  __vitehubBlobConfig?: false | ResolvedBlobModuleOptions
  __vitehubBlobHosting?: string
}

function detectRuntime(hosting: string | undefined, event: { context?: { cloudflare?: unknown, _platform?: { cloudflare?: unknown } } }): string {
  if (hosting?.includes("cloudflare") || event.context?.cloudflare || event.context?._platform?.cloudflare) return "cloudflare"
  if (hosting?.includes("vercel") || process.env.VERCEL) return "vercel"
  return "node"
}

export default defineEventHandler((event) => {
  const runtimeConfig = useRuntimeConfig() as {
    blob?: false | ResolvedBlobModuleOptions
    hosting?: string
  }
  const globals = globalThis as BlobGlobals
  const blob = runtimeConfig.blob ?? globals.__vitehubBlobConfig
  const hosting = runtimeConfig.hosting ?? globals.__vitehubBlobHosting

  return {
    feature: "blob",
    hasWaitUntil: typeof event.waitUntil === "function",
    hosting: hosting || null,
    ok: true,
    provider: blob?.provider.driver || null,
    runtime: detectRuntime(hosting, event),
  }
})
