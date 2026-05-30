import { readEnv } from "@vite-hub/internal/env"
import {
  clearActiveCloudflareEnv,
  getActiveCloudflareBinding,
  getActiveCloudflareEnv,
  runWithActiveCloudflareEnv,
  setActiveCloudflareEnv,
} from "@vite-hub/internal/runtime/cloudflare-env"

import { normalizeBlobOptions } from "../config.ts"

import type { BlobStorage, ResolvedBlobModuleOptions } from "../types.ts"

let runtimeConfig: false | ResolvedBlobModuleOptions | undefined
let runtimeConfigPromise: Promise<false | ResolvedBlobModuleOptions> | undefined
const runtimeStorages = new Map<string, BlobStorage>()

export {
  clearActiveCloudflareEnv,
  getActiveCloudflareBinding,
  getActiveCloudflareEnv,
  runWithActiveCloudflareEnv,
  setActiveCloudflareEnv,
}

export async function getBlobRuntimeConfig(): Promise<false | ResolvedBlobModuleOptions> {
  if (typeof runtimeConfig !== "undefined") {
    return runtimeConfig
  }

  runtimeConfigPromise ||= (async () => {
    const virtualConfigId = "#vitehub/blob/config"
    try {
      const module = await import(
        /* @vite-ignore */
        virtualConfigId
      ) as { blob: false | ResolvedBlobModuleOptions }
      return module.blob
    }
    catch {
      const env = typeof process !== "undefined" ? process.env : {}
      const hosting = getActiveCloudflareEnv()
        ? "cloudflare"
        : readEnv(env, "VITEHUB_HOSTING", "NITRO_PRESET") || (readEnv(env, "BLOB_READ_WRITE_TOKEN") ? "vercel" : undefined)
      return normalizeBlobOptions(undefined, { env, hosting }) || false
    }
  })()
  runtimeConfig = await runtimeConfigPromise
  return runtimeConfig
}

export function getBlobRuntimeStorage(): BlobStorage | undefined {
  return getNamedBlobRuntimeStorage("default")
}

export function getNamedBlobRuntimeStorage(name: string): BlobStorage | undefined {
  return runtimeStorages.get(name)
}

export function setBlobRuntimeConfig(config: false | ResolvedBlobModuleOptions | undefined): void {
  runtimeConfig = config
  runtimeConfigPromise = undefined
}

export function setBlobRuntimeStorage(storage: BlobStorage | undefined): void {
  setNamedBlobRuntimeStorage("default", storage)
}

export function setNamedBlobRuntimeStorage(name: string, storage: BlobStorage | undefined): void {
  if (storage) runtimeStorages.set(name, storage)
  else runtimeStorages.delete(name)
}
