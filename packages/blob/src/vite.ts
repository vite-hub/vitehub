import blobNitroModule from "./nitro/module.ts"
import { generateProviderOutputs, blobPackageName } from "./internal/vite-build.ts"
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

function mergeNoExternal(current: boolean | string | RegExp | (string | RegExp)[] | undefined) {
  if (current === true) {
    return true
  }

  if (!current) {
    return [blobPackageName]
  }

  const values = Array.isArray(current) ? current : [current]
  return values.some(value => value === blobPackageName) ? values : [...values, blobPackageName]
}

function isBlobServerEnvironment(name: string, config: { consumer?: string }) {
  return name === "ssr" || config.consumer === "server"
}

function serializeVirtualConfig(config: BlobViteRuntimeConfig): string {
  return [
    `export const hosting = ${JSON.stringify(config.hosting)};`,
    `export const blob = ${JSON.stringify(config.blob)};`,
    "export default { hosting, blob };",
  ].join("\n")
}

export function hubBlob(options?: BlobModuleOptions): BlobVitePlugin {
  let blob: BlobModuleOptions | undefined = options
  let clientOutDir = "dist"
  let command: "build" | "serve" = "serve"
  let rootDir = process.cwd()
  let runtimeConfig: BlobViteRuntimeConfig | undefined
  const getConfig = () => runtimeConfig ??= resolveBlobViteConfig(options)

  return {
    name: BLOB_VITE_PLUGIN_NAME,
    api: { getConfig },
    nitro: blobNitroModule,
    config(config, env) {
      command = env.command
      blob = config.blob ?? blob
    },
    configResolved(config) {
      clientOutDir = config.build.outDir
      rootDir = config.root
      blob = config.blob ?? blob
      runtimeConfig = resolveBlobViteConfig(blob)
    },
    configEnvironment(name, config) {
      if (!isBlobServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    async closeBundle() {
      if (command === "serve") {
        return
      }

      await generateProviderOutputs({
        blob,
        clientOutDir,
        rootDir,
      })
    },
    load(id) {
      if (id === RESOLVED_BLOB_VIRTUAL_CONFIG_ID) {
        return serializeVirtualConfig(getConfig())
      }
    },
    resolveId(id) {
      if (id === BLOB_VIRTUAL_CONFIG_ID) {
        return RESOLVED_BLOB_VIRTUAL_CONFIG_ID
      }
    },
  }
}

declare module "vite" {
  interface UserConfig {
    blob?: BlobModuleOptions
  }
}
