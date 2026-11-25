import { readEnv } from "@vite-hub/internal/env"
import {
  clearActiveCloudflareEnv,
  getActiveCloudflareBinding,
  getActiveCloudflareEnv,
  installCloudflareRequestEnv,
  runWithActiveCloudflareEnv,
  setActiveCloudflareEnv,
} from "@vite-hub/internal/runtime/cloudflare-env"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"

import { normalizeBlobOptions } from "../config.ts"
import { setServedBlobRoute } from "../served.ts"

export { loadWorkerPhoton, setBlobPhotonLoader } from "../media/photon-module.ts"
export { setBlobSharpModule } from "../media/sharp-module.ts"
export { setBlobRequestBodyLimit } from "../internal/host-limits.ts"

import type { ViteHubContext } from "@vite-hub/runtime"
import type { BlobStorage, ResolvedBlobModuleOptions } from "../types.ts"

type InstalledBlobConfig = { config: false | ResolvedBlobModuleOptions | undefined }

let runtimeConfig: InstalledBlobConfig["config"]
let runtimeConfigSnapshot: string | undefined
let runtimeConfigPromise: Promise<false | ResolvedBlobModuleOptions> | undefined
let runtimeStorages = new Map<string, BlobStorage>()
let pendingStorages = new Map<string, Promise<BlobStorage>>()

const installedConfigKey = Symbol.for("vitehub.blob.installed-config")
let observedInstall: InstalledBlobConfig | undefined

function resetRuntimeConfig(config: InstalledBlobConfig["config"], snapshot?: string): void {
  runtimeConfig = config
  runtimeConfigSnapshot = snapshot
  runtimeConfigPromise = undefined
  setServedBlobRoute(config ? config.serve : undefined)
  runtimeStorages = new Map()
  pendingStorages = new Map()
}

function syncInstalledConfig(): void {
  const install = Reflect.get(globalThis, installedConfigKey) as InstalledBlobConfig | undefined
  if (install === observedInstall) return
  observedInstall = install
  resetRuntimeConfig(undefined)
}

export {
  clearActiveCloudflareEnv,
  getActiveCloudflareBinding,
  getActiveCloudflareEnv,
  installCloudflareRequestEnv,
  runWithActiveCloudflareEnv,
  setActiveCloudflareEnv,
}

/**
 * The env that holds the store credentials at runtime: the text values of the active Cloudflare Worker env, then
 * `process.env`. A Worker does not always copy its secrets into `process.env`.
 */
export function blobRuntimeEnv(): Record<string, string | undefined> {
  const processEnv = typeof process === "undefined" ? {} : process.env
  const worker = getActiveCloudflareEnv()
  if (!worker) return processEnv
  return { ...processEnv, ...Object.fromEntries(Object.entries(worker).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
}

/** The Cloudflare bindings in the Standard Context of a request event, when the host provides them. */
export function getRequestCloudflareEnv(event: ViteHubContext): Record<string, unknown> | undefined {
  return getStandardContext(event).runtime?.cloudflare?.env
}

export async function getBlobRuntimeConfig(): Promise<false | ResolvedBlobModuleOptions> {
  syncInstalledConfig()
  if (typeof runtimeConfig !== "undefined") {
    return runtimeConfig
  }

  const installed = observedInstall?.config
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
      if (installed !== undefined) return installed
      const env = typeof process !== "undefined" ? process.env : {}
      const hosting = getActiveCloudflareEnv()
        ? "cloudflare"
        : readEnv(env, "VITEHUB_HOST")
          || (readEnv(env, "NETLIFY") || readEnv(env, "NETLIFY_DEV") || readEnv(env, "NETLIFY_LOCAL") ? "netlify" : undefined)
          || (readEnv(env, "BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN") ? "vercel" : undefined)
      return normalizeBlobOptions(undefined, { env, hosting }) || false
    }
  })()
  const pending = runtimeConfigPromise
  const config = await pending
  if (runtimeConfigPromise === pending) {
    runtimeConfig = config
    setServedBlobRoute(config ? config.serve : undefined)
  }
  return config
}

export function getBlobRuntimeStorage(): BlobStorage | undefined {
  return getNamedBlobRuntimeStorage("default")
}

export function getNamedBlobRuntimeStorage(name: string): BlobStorage | undefined {
  syncInstalledConfig()
  return runtimeStorages.get(name)
}

export function setBlobRuntimeConfig(config: false | ResolvedBlobModuleOptions | undefined): void {
  syncInstalledConfig()
  const snapshot = config === undefined ? undefined : JSON.stringify(config)
  if (config !== undefined && config === runtimeConfig && snapshot === runtimeConfigSnapshot) return
  observedInstall = { config }
  Reflect.set(globalThis, installedConfigKey, observedInstall)
  resetRuntimeConfig(config, snapshot)
}

export function setBlobRuntimeStorage(storage: BlobStorage | undefined): void {
  setNamedBlobRuntimeStorage("default", storage)
}

export function setNamedBlobRuntimeStorage(name: string, storage: BlobStorage | undefined): void {
  syncInstalledConfig()
  pendingStorages.delete(name)
  if (storage) runtimeStorages.set(name, storage)
  else runtimeStorages.delete(name)
}

/** Shares one initialization per store and keeps completed work within its configuration lifetime. */
export function resolveNamedBlobRuntimeStorage(
  name: string,
  create: (config: false | ResolvedBlobModuleOptions) => Promise<BlobStorage>,
): Promise<BlobStorage> {
  syncInstalledConfig()
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
