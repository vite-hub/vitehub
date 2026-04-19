import type { ResolvedBlobModuleOptions } from "../types.ts"
import type { BlobStorage } from "./types.ts"

let blobConfig: false | ResolvedBlobModuleOptions | undefined
let blobStore: BlobStorage | undefined
let blobHosting: string | undefined

export function getBlobRuntimeConfig(): false | ResolvedBlobModuleOptions | undefined {
  return blobConfig
}

export function setBlobRuntimeConfig(config: false | ResolvedBlobModuleOptions | undefined): void {
  blobConfig = config
}

export function getBlobRuntimeHosting(): string | undefined {
  return blobHosting
}

export function setBlobRuntimeHosting(hosting: string | undefined): void {
  blobHosting = hosting
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
  blobHosting = undefined
}
