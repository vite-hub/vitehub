import { defineNuxtModule } from "@nuxt/kit"
import type { BlobModuleOptions } from "../types.ts"
import type { NitroConfig } from "nitro/types"
import type { NuxtModule } from "@nuxt/schema"

const NITRO_MODULE_ID = "@vitehub/blob/nitro"
type BlobNuxtOptions = Exclude<BlobModuleOptions, false>

function installBlobNitroModule(nitro: NitroConfig, blob: BlobModuleOptions | undefined): void {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) nitro.modules.push(NITRO_MODULE_ID)
  if (blob !== undefined) nitro.blob = blob
}

const blobNuxtModule: NuxtModule<BlobNuxtOptions, BlobNuxtOptions, false> = defineNuxtModule<BlobNuxtOptions>({
  meta: { configKey: "blob", name: "@vitehub/blob/nuxt" },
  setup(inlineOptions, nuxt) {
    const topLevel = nuxt.options.blob
    if (topLevel === false) return

    const blob = topLevel ?? inlineOptions
    nuxt.options.nitro ||= {}
    installBlobNitroModule(nuxt.options.nitro, blob)
    nuxt.hook("nitro:config", config => installBlobNitroModule(config, blob))
  },
})

export default blobNuxtModule

declare module "@nuxt/schema" {
  interface NuxtConfig {
    blob?: BlobModuleOptions
    nitro?: NitroConfig
  }
  interface NuxtOptions {
    blob?: BlobModuleOptions
    nitro?: NitroConfig
  }
  interface NuxtHooks {
    "nitro:config": (config: NitroConfig) => void | Promise<void>
  }
}
