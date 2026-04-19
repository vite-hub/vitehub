import { defineNuxtModule } from "@nuxt/kit"
import type { BlobModuleOptions } from "../types.ts"
import type { NitroConfig } from "nitro/types"

type BlobNuxtOptions = Exclude<BlobModuleOptions, false>

const NITRO_MODULE_ID = "@vitehub/blob/nitro"

function installBlobNitroModule(nitro: NitroConfig, blob: BlobModuleOptions | undefined): void {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) nitro.modules.push(NITRO_MODULE_ID)
  if (blob !== undefined) nitro.blob = blob
}

function pickBlobOptions(topLevel: BlobModuleOptions | undefined, inline: BlobNuxtOptions): BlobModuleOptions | undefined {
  if (topLevel !== undefined) return topLevel
  return Object.keys(inline).length > 0 ? inline : undefined
}

const blobNuxtModule: ReturnType<typeof defineNuxtModule<BlobNuxtOptions>> = defineNuxtModule<BlobNuxtOptions>({
  meta: { configKey: "blob", name: "@vitehub/blob/nuxt" },
  setup(inlineOptions: BlobNuxtOptions, nuxt: { options: Record<string, any>; hook: (...args: any[]) => unknown }) {
    const nuxtOptions = nuxt.options as Record<string, any>
    const topLevel = nuxtOptions.blob as BlobModuleOptions | undefined
    if (topLevel === false) return

    const blob = pickBlobOptions(topLevel, inlineOptions)
    const nitro = nuxtOptions.nitro ||= {}
    installBlobNitroModule(nitro, blob)
    ;(nuxt.hook as any)("nitro:config", (config: NitroConfig) => installBlobNitroModule(config, blob))
  },
})

export default blobNuxtModule
