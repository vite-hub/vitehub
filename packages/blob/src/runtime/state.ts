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
let runtimeConfigSnapshot: string | undefined
const functionIds = new WeakMap<Function, number>()
let nextFunctionId = 0
let runtimeConfigPromise: Promise<false | ResolvedBlobModuleOptions> | undefined
let runtimeStorages = new Map<string, BlobStorage>()
let pendingStorages = new Map<string, Promise<BlobStorage>>()

function isCallable(value: unknown): value is Function {
  if (value === null || value === undefined) return false
  try {
    Function.prototype.bind.call(value as Function, undefined)
    return true
  }
  catch {
    return false
  }
}

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
        : readEnv(env, "VITEHUB_HOSTING")
          || (readEnv(env, "NETLIFY") || readEnv(env, "NETLIFY_DEV") || readEnv(env, "NETLIFY_LOCAL") ? "netlify" : undefined)
          || (readEnv(env, "BLOB_READ_WRITE_TOKEN") ? "vercel" : undefined)
      return normalizeBlobOptions(undefined, { env, hosting }) || false
    }
  })()
  const pending = runtimeConfigPromise
  const config = await pending
  if (runtimeConfigPromise === pending) runtimeConfig = config
  return config
}

export function getBlobRuntimeStorage(): BlobStorage | undefined {
  return getNamedBlobRuntimeStorage("default")
}

export function getNamedBlobRuntimeStorage(name: string): BlobStorage | undefined {
  return runtimeStorages.get(name)
}

export function setBlobRuntimeConfig(config: false | ResolvedBlobModuleOptions | undefined): void {
  const snapshot = config === undefined ? undefined : JSON.stringify(config, (_key, value: unknown) => {
    if (!isCallable(value)) return value
    let id = functionIds.get(value)
    if (id === undefined) {
      id = ++nextFunctionId
      functionIds.set(value, id)
    }
    return { __viteHubFunctionId: id }
  })
  if (config !== undefined && config === runtimeConfig && snapshot === runtimeConfigSnapshot) return
  runtimeConfig = config
  runtimeConfigSnapshot = snapshot
  runtimeConfigPromise = undefined
  runtimeStorages = new Map()
  pendingStorages = new Map()
}

export function setBlobRuntimeStorage(storage: BlobStorage | undefined): void {
  setNamedBlobRuntimeStorage("default", storage)
}

export function setNamedBlobRuntimeStorage(name: string, storage: BlobStorage | undefined): void {
  pendingStorages.delete(name)
  if (storage) runtimeStorages.set(name, storage)
  else runtimeStorages.delete(name)
}

/** Shares one initialization per store and keeps completed work within its configuration lifetime. */
export function resolveNamedBlobRuntimeStorage(
  name: string,
  create: (config: false | ResolvedBlobModuleOptions) => Promise<BlobStorage>,
): Promise<BlobStorage> {
  const existing = runtimeStorages.get(name)
  if (existing) return Promise.resolve(existing)
  const initializing = pendingStorages.get(name)
  if (initializing) return initializing

  const storages = runtimeStorages
  const pending = pendingStorages
  const initialization = getBlobRuntimeConfig().then(create).then((storage) => {
    if (pending.get(name) === initialization) {
      storages.set(name, storage)
      pending.delete(name)
    }
    return storage
  }, (error: unknown) => {
    if (pending.get(name) === initialization) pending.delete(name)
    throw error
  })
  pending.set(name, initialization)
  return initialization
}
