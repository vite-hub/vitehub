import { resolveModulePath } from "exsolve"
import type { NitroModule, NitroRuntimeConfig } from "nitro/types"

import { normalizeBlobOptions, warnVercelBlobFallback } from "../config.ts"
import { configureCloudflareR2 } from "../integrations/cloudflare.ts"

import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "../types.ts"

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

const blobNitroModule: NitroModule = {
  name: "@vitehub/blob",
  setup(nitro) {
    const resolved = normalizeBlobOptions(nitro.options.blob, {
      env: process.env,
      hosting: nitro.options.preset,
    })
    const hosting = nitro.options.preset

    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (hosting) {
      runtimeConfig.hosting ||= hosting
    }
    runtimeConfig.blob = resolved || false

    if (!resolved) {
      return
    }

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/blob"] = resolveRuntimeEntry("../index", "@vitehub/blob")
    nitro.options.alias["@vitehub/blob/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vitehub/blob/runtime/state")

    nitro.options.plugins ||= []
    const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/blob/runtime/nitro-plugin")
    if (!nitro.options.plugins.includes(plugin)) {
      nitro.options.plugins.push(plugin)
    }

    if (hosting?.includes("cloudflare")) {
      configureCloudflareR2(nitro.options, resolved)
    }
    warnVercelBlobFallback(nitro, resolved, hosting)
  },
}

export default blobNitroModule

declare module "nitro/types" {
  interface NitroOptions {
    blob?: BlobModuleOptions
    cloudflare?: { wrangler?: { r2_buckets?: Array<{ binding: string, bucket_name: string }> } }
  }

  interface NitroConfig {
    blob?: BlobModuleOptions
  }

  interface NitroRuntimeConfig {
    blob?: false | ResolvedBlobModuleOptions
    hosting?: string
  }
}
