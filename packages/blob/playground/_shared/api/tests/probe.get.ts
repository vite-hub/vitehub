import { defineEventHandler } from "h3"
import type { ResolvedBlobModuleOptions } from "../../../src/types.ts"

type BlobGlobals = typeof globalThis & {
  __vitehubBlobConfig?: false | ResolvedBlobModuleOptions
  __vitehubBlobHosting?: string
}

function detectRuntime(hosting: string | undefined, event: { context?: { cloudflare?: unknown, _platform?: { cloudflare?: unknown } } }): string {
  if (hosting === "cloudflare-module" || event.context?.cloudflare || event.context?._platform?.cloudflare) return "cloudflare"
  if (process.env.VERCEL) return "vercel"
  return "node"
}

export default defineEventHandler((event) => {
  const { __vitehubBlobConfig: blob, __vitehubBlobHosting: hosting } = globalThis as BlobGlobals

  return {
    feature: "blob",
    hasWaitUntil: typeof event.waitUntil === "function",
    hosting,
    ok: true,
    provider: blob && blob.provider.driver,
    runtime: detectRuntime(hosting, event),
  }
})
