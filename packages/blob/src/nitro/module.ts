import { resolveModulePath } from "exsolve"
import { normalizeBlobOptions } from "../config.ts"
import { hubBlob } from "../vite.ts"
import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "../types.ts"
import type { NitroModule, NitroRuntimeConfig } from "nitro/types"
import type { Plugin } from "vite"

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

function installVitePlugin(nitroOptions: NitroOptionsLike): void {
  nitroOptions.vite ||= {}
  nitroOptions.vite.plugins ||= []
  nitroOptions.vite.plugins.push(hubBlob())
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
  vite?: {
    plugins?: Plugin[]
  }
}

const blobNitroModule: NitroModule = {
  name: "@vitehub/blob",
  setup(nitro) {
    const nitroOptions = nitro.options as NitroOptionsLike
    const hosting = (nitroOptions.preset || process.env.NITRO_PRESET || "").trim() || undefined
    const resolved = normalizeBlobOptions(nitroOptions.blob, { hosting })
    const runtimeConfig = (nitroOptions.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (hosting) runtimeConfig.hosting ||= hosting
    runtimeConfig.blob = resolved ?? false

    installVitePlugin(nitroOptions)
    if (!resolved) return

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
    vite?: {
      plugins?: Plugin[]
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
