import { createBlobStorage } from "../storage.ts"
import { resolveRuntimeMinioBlobStore, resolveRuntimeVercelBlobStore } from "../config.ts"
import { createDriver as createCloudflareR2NativeDriver, getOptionalBucket } from "../drivers/cloudflare-native.ts"

import { getBlobRuntimeConfig, getNamedBlobRuntimeStorage, setNamedBlobRuntimeStorage } from "./state.ts"

import type { BlobDriverAdapter, BlobObject, BlobStorage, BlobStoreName, ResolvedBlobModuleOptions, ResolvedBlobStoreConfig, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"

const driverModules = {
  akamai: "akamai",
  azure: "azure",
  box: "box",
  "cloudflare-r2": "cloudflare",
  "digitalocean-spaces": "digitalocean-spaces",
  dropbox: "dropbox",
  fs: "fs",
  gcs: "gcs",
  "google-drive": "google-drive",
  hetzner: "hetzner",
  minio: "minio",
  "netlify-blobs": "netlify-blobs",
  onedrive: "onedrive",
  s3: "s3",
  storj: "storj",
  supabase: "supabase",
  uploadthing: "uploadthing",
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

async function createConfiguredBlobStorage(config: ResolvedBlobModuleOptions): Promise<BlobStorage> {
  const resolvedConfig = {
    ...config,
    store: resolveRuntimeBlobStore(config.store),
  }
  const driver = await importRuntimeDriver(resolvedConfig.store)
  return createBlobStorage(driver)
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
  if (!store) throw new Error(`Unknown Blob store "${name}".`)
  const storage = await createConfiguredBlobStorage({ store, stores: { default: store, [name]: store } })
  setNamedBlobRuntimeStorage(name, storage)
  return storage
}

function createRuntimeBlobStorage(name = "default"): BlobStorage {
  return {
    async del(pathnames) { await (await resolveStorage(name)).del(pathnames) },
    async get(pathname) { return (await resolveStorage(name)).get(pathname) },
    async head(pathname) { return withServedBlobUrl(name, await (await resolveStorage(name)).head(pathname)) },
    async list(options) {
      const result = await (await resolveStorage(name)).list(options)
      return { ...result, blobs: await Promise.all(result.blobs.map(object => withServedBlobUrl(name, object))) }
    },
    async put(pathname, body, options) { return withServedBlobUrl(name, await (await resolveStorage(name)).put(pathname, body, options)) },
    async sign(pathname, options) { return (await resolveStorage(name)).sign(pathname, options) },
    async serve(event, pathname) { return (await resolveStorage(name)).serve(event, pathname) },
    store(storeName: BlobStoreName) { return createRuntimeBlobStorage(storeName) },
  }
}

export const blob: BlobStorage = createRuntimeBlobStorage()
