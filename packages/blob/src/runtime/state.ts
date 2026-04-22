import { normalizeBlobOptions } from "../config.ts"
import { readEnv } from "../internal/env.ts"

import type { BlobStorage, ResolvedBlobModuleOptions } from "../types.ts"

let activeCloudflareEnv: Record<string, unknown> | undefined
let runtimeConfig: false | ResolvedBlobModuleOptions | undefined
let runtimeConfigPromise: Promise<false | ResolvedBlobModuleOptions> | undefined
let runtimeStorage: BlobStorage | undefined

export function getActiveCloudflareBinding<T>(name: string): T | undefined {
  return activeCloudflareEnv?.[name] as T | undefined
}

export async function getBlobRuntimeConfig(): Promise<false | ResolvedBlobModuleOptions> {
  if (typeof runtimeConfig !== "undefined") {
    return runtimeConfig
  }

  runtimeConfigPromise ||= (async () => {
    const virtualConfigId = "virtual:@vitehub/blob/config"
    try {
      const module = await import(
        /* @vite-ignore */
        virtualConfigId
      ) as { blob: false | ResolvedBlobModuleOptions }
      return module.blob
    }
    catch {
      const env = typeof process !== "undefined" ? process.env : {}
      const hosting = activeCloudflareEnv
        ? "cloudflare"
        : readEnv(env, "VITEHUB_HOSTING", "NITRO_PRESET") || (readEnv(env, "BLOB_READ_WRITE_TOKEN") ? "vercel" : undefined)
      return normalizeBlobOptions(undefined, { env, hosting }) || false
    }
  })()
  runtimeConfig = await runtimeConfigPromise
  return runtimeConfig
}

export function getBlobRuntimeStorage(): BlobStorage | undefined {
  return runtimeStorage
}

export function setActiveCloudflareEnv(env: Record<string, unknown> | undefined): void {
  activeCloudflareEnv = env
}

export function setBlobRuntimeConfig(config: false | ResolvedBlobModuleOptions | undefined): void {
  runtimeConfig = config
  runtimeConfigPromise = undefined
}

export function setBlobRuntimeStorage(storage: BlobStorage | undefined): void {
  runtimeStorage = storage
}
