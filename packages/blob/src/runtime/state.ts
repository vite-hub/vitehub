import type { ResolvedBlobModuleOptions } from "../types.ts"
import type { BlobStorage } from "./types.ts"

let blobConfig: false | ResolvedBlobModuleOptions | undefined
let blobStore: BlobStorage | undefined

export function getBlobRuntimeConfig(): false | ResolvedBlobModuleOptions | undefined {
  return blobConfig
}

export function setBlobRuntimeConfig(config: false | ResolvedBlobModuleOptions | undefined): void {
  blobConfig = config
}

export function getBlobRuntimeStore(): BlobStorage | undefined {
  return blobStore
}

export function setBlobRuntimeStore(store: BlobStorage): BlobStorage {
  blobStore = store
  return store
}

export function resetBlobRuntimeState(): void {
  blobConfig = undefined
  blobStore = undefined
}
