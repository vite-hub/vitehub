import { createVercelBlobDriver } from "./drivers/vercel-blob.ts"
import { useRuntimeConfig } from "nitro/runtime-config"
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

type GlobalWithConfig = typeof globalThis & { __vitehubBlobConfig?: false | ResolvedBlobModuleOptions }

function readNitroBlobRuntimeConfig(): false | ResolvedBlobModuleOptions | undefined {
  try {
    return (useRuntimeConfig() as {
      blob?: false | ResolvedBlobModuleOptions
    }).blob
  }
  catch {
    return undefined
  }
}

function resolveRuntimeConfig(): false | ResolvedBlobModuleOptions | undefined {
  return getBlobRuntimeConfig() ?? readNitroBlobRuntimeConfig() ?? (globalThis as GlobalWithConfig).__vitehubBlobConfig
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
