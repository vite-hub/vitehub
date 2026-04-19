import blobNitroModule from "./nitro/module.ts"
import {
  BLOB_VIRTUAL_CONFIG_ID,
  BLOB_VITE_PLUGIN_NAME,
  resolveBlobViteConfig,
} from "./vite-config.ts"

import type { BlobViteRuntimeConfig } from "./vite-config.ts"
import type { BlobModuleOptions } from "./types.ts"
import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"

const RESOLVED_BLOB_VIRTUAL_CONFIG_ID = `\0${BLOB_VIRTUAL_CONFIG_ID}`

export { BLOB_VIRTUAL_CONFIG_ID, BLOB_VITE_PLUGIN_NAME, resolveBlobViteConfig }
export type { BlobViteRuntimeConfig } from "./vite-config.ts"

export interface BlobVitePluginAPI {
  getConfig: () => BlobViteRuntimeConfig
}

export type BlobVitePlugin = Plugin & { api: BlobVitePluginAPI, nitro: NitroModule }

function serializeVirtualConfig(config: BlobViteRuntimeConfig): string {
  return [
    `export const blob = ${JSON.stringify(config.blob)};`,
    `export const hosting = ${JSON.stringify(config.hosting)};`,
    "export default { blob, hosting };",
  ].join("\n")
}

export function hubBlob(options?: BlobModuleOptions): BlobVitePlugin {
  let runtimeConfig: BlobViteRuntimeConfig | undefined
  const getConfig = (): BlobViteRuntimeConfig => runtimeConfig ??= resolveBlobViteConfig(options)

  return {
    name: BLOB_VITE_PLUGIN_NAME,
    api: { getConfig },
    nitro: blobNitroModule,
    configResolved(config) {
      runtimeConfig = resolveBlobViteConfig(config.blob ?? options)
    },
    resolveId(id) {
      if (id === BLOB_VIRTUAL_CONFIG_ID) return RESOLVED_BLOB_VIRTUAL_CONFIG_ID
    },
    load(id) {
      if (id === RESOLVED_BLOB_VIRTUAL_CONFIG_ID) return serializeVirtualConfig(getConfig())
    },
  }
}

declare module "vite" {
  interface UserConfig {
    blob?: BlobModuleOptions
  }
}
