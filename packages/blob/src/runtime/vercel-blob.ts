import { createVercelBlobDriver } from "./drivers/vercel-blob.ts"
import {
  getBlobRuntimeConfig,
  getBlobRuntimeStore,
  setBlobRuntimeStore,
} from "./state.ts"
import { createBlobStorage } from "./storage.ts"
import type { ResolvedBlobModuleOptions } from "../types.ts"
import type { BlobStorage } from "./types.ts"

export { ensureBlob } from "./ensure.ts"
export type {
  BlobBody,
  BlobEnsureOptions,
  BlobListOptions,
  BlobListResult,
  BlobObject,
  BlobPutOptions,
  BlobReadableStream,
  BlobStorage,
  BlobType,
} from "./types.ts"
export type {
  BlobModuleOptions,
  CloudflareR2BlobConfig,
  ResolvedBlobModuleOptions,
  ResolvedBlobProviderConfig,
  ResolvedCloudflareR2BlobConfig,
  ResolvedVercelBlobConfig,
  VercelBlobConfig,
} from "../types.ts"

function resolveRuntimeConfig(): false | ResolvedBlobModuleOptions | undefined {
  return getBlobRuntimeConfig()
    ?? (globalThis as typeof globalThis & { __vitehubBlobConfig?: false | ResolvedBlobModuleOptions }).__vitehubBlobConfig
}

function createBlobClient(): BlobStorage {
  const config = resolveRuntimeConfig()
  if (!config || config.provider.driver !== "vercel-blob") {
    throw new Error("[vitehub] Vercel Blob storage is not configured.")
  }
  return createBlobStorage(createVercelBlobDriver(config.provider))
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
