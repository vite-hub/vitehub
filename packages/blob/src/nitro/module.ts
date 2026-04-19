import { resolveModulePath } from "exsolve"
import { resolveBlobViteConfig } from "../vite-config.ts"

import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "../types.ts"
import type { NitroModule, NitroRuntimeConfig } from "nitro/types"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  const fromSource = resolveModulePath(srcRelative, {
    extensions: [".ts", ".mts"],
    from: import.meta.url,
    try: true,
  })
  return fromSource ?? resolveModulePath(packageSubpath, {
    extensions: [".js", ".mjs"],
    from: import.meta.url,
  })
}

function pushUnique<T>(items: T[], item: T): void {
  if (!items.includes(item)) items.push(item)
}

type NitroOptionsLike = {
  alias?: Record<string, string>
  blob?: BlobModuleOptions
  cloudflare?: {
    wrangler?: {
      r2_buckets?: Array<Record<string, unknown>>
    }
  }
  externals?: {
    inline?: string[]
  }
  plugins?: string[]
  preset?: string
  runtimeConfig?: NitroRuntimeConfig
}

function configureCloudflareR2(nitroOptions: NitroOptionsLike, resolved: ResolvedBlobModuleOptions | undefined): void {
  if (resolved?.provider.driver !== "cloudflare-r2" || !resolved.provider.bucketName) return
  const provider = resolved.provider

  nitroOptions.cloudflare ||= {}
  nitroOptions.cloudflare.wrangler ||= {}
  nitroOptions.cloudflare.wrangler.r2_buckets ||= []

  const buckets = nitroOptions.cloudflare.wrangler.r2_buckets
  if (buckets.some(entry => entry.binding === provider.binding)) return

  const bucket: Record<string, unknown> = {
    binding: provider.binding,
    bucket_name: provider.bucketName,
  }
  if (provider.jurisdiction) bucket.jurisdiction = provider.jurisdiction
  buckets.push(bucket)
}

function configureVercelBlobBundling(nitroOptions: NitroOptionsLike, resolved: ResolvedBlobModuleOptions | undefined): void {
  if (resolved?.provider.driver !== "vercel-blob") return

  nitroOptions.externals ||= {}
  nitroOptions.externals.inline ||= []
  pushUnique(nitroOptions.externals.inline, "@vercel/blob")
}

const blobNitroModule: NitroModule = {
  name: "@vitehub/blob",
  setup(nitro) {
    const nitroOptions = nitro.options as NitroOptionsLike
    const viteConfig = resolveBlobViteConfig(nitroOptions.blob, {
      env: process.env,
      hosting: nitroOptions.preset,
    })
    const { hosting } = viteConfig

    const runtimeConfig = (nitroOptions.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (hosting) runtimeConfig.hosting ||= hosting
    runtimeConfig.blob = viteConfig.blob

    if (!viteConfig.blob) return
    const resolved = viteConfig.blob

    nitroOptions.alias ||= {}
    nitroOptions.alias["@vitehub/blob"] = resolveRuntimeEntry("../index", "@vitehub/blob")

    nitroOptions.plugins ||= []
    const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/blob/runtime/nitro-plugin")
    pushUnique(nitroOptions.plugins, plugin)

    configureCloudflareR2(nitroOptions, resolved)
    configureVercelBlobBundling(nitroOptions, resolved)
  },
}

export default blobNitroModule

declare module "nitro/types" {
  interface NitroOptions {
    blob?: BlobModuleOptions
    cloudflare?: {
      wrangler?: {
        r2_buckets?: Array<Record<string, unknown>>
      }
    }
  }

  interface NitroConfig {
    blob?: BlobModuleOptions
  }

  interface NitroRuntimeConfig {
    blob?: false | ResolvedBlobModuleOptions
    hosting?: string
  }
}
