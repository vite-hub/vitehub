import { createCloudflareR2Driver } from "./drivers/cloudflare-r2.ts"
import { useRuntimeConfig } from "nitro/runtime"
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
  if (!config || config.provider.driver !== "cloudflare-r2") {
    throw new Error("[vitehub] Cloudflare R2 blob storage is not configured.")
  }
  return createBlobStorage(createCloudflareR2Driver(config.provider))
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
