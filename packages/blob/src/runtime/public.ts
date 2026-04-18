import { createCloudflareR2Driver } from "./drivers/cloudflare-r2.ts"
import { createVercelBlobDriver } from "./drivers/vercel-blob.ts"
import {
  getBlobRuntimeConfig,
  getBlobRuntimeStore,
  setBlobRuntimeStore,
} from "./state.ts"
import { createBlobStorage } from "./storage.ts"
import type { ResolvedBlobModuleOptions } from "../types.ts"
import type { BlobStorage } from "./types.ts"

function resolveRuntimeConfig(): false | ResolvedBlobModuleOptions | undefined {
  try {
    return getBlobRuntimeConfig()
      ?? (globalThis as typeof globalThis & { __vitehubBlobConfig?: false | ResolvedBlobModuleOptions }).__vitehubBlobConfig
  }
  catch {
    return getBlobRuntimeConfig()
  }
}

function createBlobClient(): BlobStorage {
  const config = resolveRuntimeConfig()
  if (!config) {
    throw new Error("[vitehub] Blob storage is not configured. Register `@vitehub/blob/nitro` or `@vitehub/blob/nuxt`, or configure a supported blob provider.")
  }

  switch (config.provider.driver) {
    case "cloudflare-r2":
      return createBlobStorage(createCloudflareR2Driver(config.provider))
    case "vercel-blob":
      return createBlobStorage(createVercelBlobDriver(config.provider))
    default:
      throw new Error("[vitehub] Unsupported blob provider.")
  }
}

function createBlobProxy(): BlobStorage {
  let resolved: BlobStorage | undefined
  const resolve = (): BlobStorage => resolved ||= createBlobClient()

  return new Proxy({} as BlobStorage, {
    get(_target, key, receiver) {
      return Reflect.get(resolve(), key, receiver)
    },
    getOwnPropertyDescriptor(_target, key) {
      return Object.getOwnPropertyDescriptor(resolve(), key)
    },
    has(_target, key) {
      return key in resolve()
    },
    ownKeys() {
      return Reflect.ownKeys(resolve())
    },
  })
}

export const blob: BlobStorage = getBlobRuntimeStore() || setBlobRuntimeStore(createBlobProxy())
