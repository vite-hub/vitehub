import { createBlobStorage } from "../storage.ts"
import { blobResult } from "../errors.ts"
import { resolveRuntimeMinioBlobStore, resolveRuntimeVercelBlobStore } from "../config.ts"
import { createDriver as createCloudflareR2NativeDriver, getOptionalBucket } from "../drivers/cloudflare-native.ts"

import { getBlobRuntimeConfig, getNamedBlobRuntimeStorage, setNamedBlobRuntimeStorage } from "./state.ts"

import type { BlobDriverAdapter, BlobObject, BlobOperation, BlobResult, BlobStorage, BlobStoreName, ResolvedBlobModuleOptions, ResolvedBlobStoreConfig, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"

class UnknownBlobStoreError extends Error {}

const driverModules = {
  akamai: "files",
  azure: "files",
  box: "files",
  "cloudflare-r2": "files",
  "digitalocean-spaces": "files",
  dropbox: "files",
  fs: "fs",
  gcs: "files",
  "google-drive": "files",
  hetzner: "files",
  minio: "files",
  "netlify-blobs": "netlify-blobs",
  onedrive: "files",
  s3: "files",
  storj: "files",
  supabase: "files",
  uploadthing: "files",
  "vercel-blob": "vercel",
} satisfies Record<ResolvedBlobStoreConfig["driver"], string>

async function importRuntimeDriver(config: ResolvedBlobStoreConfig) {
  if (config.driver === "cloudflare-r2") {
    const nativeDriver = createCloudflareR2NativeDriver(config)
    let fallbackDriver: Promise<BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig>> | undefined
    const activeDriver = async () => {
      if (getOptionalBucket(config)) return nativeDriver
      fallbackDriver ||= importRuntimeDriverModule(config)
      return fallbackDriver
    }
    return {
      name: config.driver,
      options: config,
      delete: async pathnames => (await activeDriver()).delete(pathnames),
      get: async pathname => (await activeDriver()).get(pathname),
      getArrayBuffer: async pathname => (await activeDriver()).getArrayBuffer(pathname),
      head: async pathname => (await activeDriver()).head(pathname),
      list: async options => (await activeDriver()).list(options),
      put: async (pathname, body, options) => (await activeDriver()).put(pathname, body, options),
      sign: (pathname, options) => nativeDriver.sign!(pathname, options),
    } satisfies BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig>
  }

  return importRuntimeDriverModule(config)
}

async function importRuntimeDriverModule(config: ResolvedBlobStoreConfig) {
  const isSourceRuntime = typeof import.meta !== "undefined"
    && typeof import.meta.url === "string"
    && import.meta.url.endsWith(".ts")

  const moduleName = driverModules[config.driver]
  const modulePath = isSourceRuntime
    ? new URL(`../drivers/${moduleName}.ts`, import.meta.url).href
    : `@vite-hub/blob/drivers/${moduleName}`
  const module = await import(modulePath) as { createDriver: (options: typeof config) => any }
  return module.createDriver(config)
}

function resolveRuntimeBlobStore(store: ResolvedBlobStoreConfig): ResolvedBlobStoreConfig {
  if (store.driver === "minio") {
    return resolveRuntimeMinioBlobStore(store, process.env)
  }
  if (store.driver === "vercel-blob") {
    return resolveRuntimeVercelBlobStore(store, process.env)
  }
  return store
}

async function createConfiguredBlobStorage(config: ResolvedBlobModuleOptions, name: string): Promise<BlobStorage> {
  const resolvedConfig = {
    ...config,
    store: resolveRuntimeBlobStore(config.store),
  }
  const driver = await importRuntimeDriver(resolvedConfig.store)
  return createBlobStorage(driver, name)
}

function joinServedBlobUrl(...parts: string[]): string {
  const [first, ...rest] = parts.filter(Boolean)
  if (!first) return ""
  const base = first.replace(/\/+$/, "")
  const path = rest.map(part => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")
  if (!base) return path ? `/${path}` : "/"
  return path ? `${base}/${path}` : base
}

async function withServedBlobUrl(name: string, object: BlobObject): Promise<BlobObject> {
  const config = await getBlobRuntimeConfig()
  const serve = config && typeof config === "object" ? config.serve : undefined
  if (!serve || serve.store !== name) return object
  return { ...object, url: joinServedBlobUrl(serve.publicBaseUrl || "/", serve.route, object.pathname) }
}

async function resolveStorage(name = "default") {
  const existing = getNamedBlobRuntimeStorage(name)
  if (existing) {
    return existing
  }

  const config = await getBlobRuntimeConfig()
  if (!config) {
    throw new Error("Blob runtime is disabled.")
  }

  const stores = config.stores || { default: config.store }
  const store = stores[name]
  if (!store) throw new UnknownBlobStoreError(`Unknown Blob store "${name}".`)
  const storage = await createConfiguredBlobStorage({ store, stores: { default: store, [name]: store } }, name)
  setNamedBlobRuntimeStorage(name, storage)
  return storage
}

async function resolveStorageResult(operation: BlobOperation, name: string): Promise<BlobResult<BlobStorage>> {
  const result = await blobResult(operation, name, () => resolveStorage(name))
  if (result[0]?.cause instanceof UnknownBlobStoreError) throw result[0].cause
  return result
}

function createRuntimeBlobStorage(name = "default"): BlobStorage {
  return {
    async del(pathnames) {
      const [error, storage] = await resolveStorageResult("del", name)
      return error ? [error, undefined] : storage.del(pathnames)
    },
    async get(pathname) {
      const [error, storage] = await resolveStorageResult("get", name)
      return error ? [error, undefined] : storage.get(pathname)
    },
    async head(pathname) {
      const [resolutionError, storage] = await resolveStorageResult("head", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, object] = await storage.head(pathname)
      return error ? [error, undefined] : [null, await withServedBlobUrl(name, object)]
    },
    async list(options) {
      const [resolutionError, storage] = await resolveStorageResult("list", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, result] = await storage.list(options)
      return error
        ? [error, undefined]
        : [null, { ...result, blobs: await Promise.all(result.blobs.map(object => withServedBlobUrl(name, object))) }]
    },
    async put(pathname, body, options) {
      const [resolutionError, storage] = await resolveStorageResult("put", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, object] = await storage.put(pathname, body, options)
      return error ? [error, undefined] : [null, await withServedBlobUrl(name, object)]
    },
    async sign(pathname, options) {
      const [error, storage] = await resolveStorageResult("sign", name)
      return error ? [error, undefined] : storage.sign(pathname, options)
    },
    async serve(event, pathname) {
      const [error, storage] = await resolveStorageResult("serve", name)
      return error ? [error, undefined] : storage.serve(event, pathname)
    },
    store(storeName: BlobStoreName) { return createRuntimeBlobStorage(storeName) },
  }
}

export const blob: BlobStorage = createRuntimeBlobStorage()
