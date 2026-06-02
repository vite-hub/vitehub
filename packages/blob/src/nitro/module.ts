import { assertNoVitePluginInNitro, resolveRuntimeEntry as resolveEntry } from "@vite-hub/internal/nitro"
import type { NitroModule, NitroRuntimeConfig } from "nitro/types"

import { normalizeBlobOptions, warnVercelBlobFallback } from "../config.ts"
import { configureCloudflareR2 } from "../integrations/cloudflare.ts"

import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "../types.ts"

const BLOB_VITE_PLUGIN_NAME = "@vite-hub/blob/vite"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

const blobNitroModule: NitroModule = {
  name: "@vite-hub/blob",
  async setup(nitro) {
    await assertNoVitePluginInNitro(nitro, BLOB_VITE_PLUGIN_NAME, "@vite-hub/blob/nitro")

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
    nitro.options.alias["@vite-hub/blob"] = resolveRuntimeEntry("../index", "@vite-hub/blob")
    nitro.options.alias["@vite-hub/blob/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vite-hub/blob/runtime/state")

    nitro.options.plugins ||= []
    const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vite-hub/blob/internal/runtime/nitro-plugin")
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
