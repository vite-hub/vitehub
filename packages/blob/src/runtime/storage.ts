import { createBlobStorage } from "../storage.ts"
import { resolveRuntimeVercelBlobStore } from "../config.ts"

import { getBlobRuntimeConfig, getNamedBlobRuntimeStorage, setNamedBlobRuntimeStorage } from "./state.ts"

import type { BlobStorage, BlobStoreName, ResolvedBlobModuleOptions, ResolvedBlobStoreConfig } from "../types.ts"

async function importRuntimeDriver(config: ResolvedBlobStoreConfig) {
  const isSourceRuntime = typeof import.meta !== "undefined"
    && typeof import.meta.url === "string"
    && import.meta.url.endsWith(".ts")

  switch (config.driver) {
    case "cloudflare-r2": {
      const module = (isSourceRuntime
        ? await import("../drivers/cloudflare.ts")
        : await import("../drivers/cloudflare.js")) as { createDriver: (options: typeof config) => any }
      return module.createDriver(config)
    }
    case "fs": {
      const module = (isSourceRuntime
        ? await import("../drivers/fs.ts")
        : await import("../drivers/fs.js")) as { createDriver: (options: typeof config) => any }
      return module.createDriver(config)
    }
    case "vercel-blob": {
      const module = (isSourceRuntime
        ? await import("../drivers/vercel.ts")
        : await import("../drivers/vercel.js")) as { createDriver: (options: typeof config) => any }
      return module.createDriver(config)
    }
    default: {
      const modulePath = new URL(isSourceRuntime ? "../drivers/files.ts" : "../drivers/files.js", import.meta.url).href
      const module = await import(modulePath) as { createDriver: (options: typeof config) => any }
      return module.createDriver(config)
    }
  }
}

async function createConfiguredBlobStorage(config: ResolvedBlobModuleOptions): Promise<BlobStorage> {
  const resolvedConfig = config.store.driver === "vercel-blob"
    ? {
        ...config,
        store: resolveRuntimeVercelBlobStore(config.store, process.env),
      }
    : config
  const driver = await importRuntimeDriver(resolvedConfig.store)
  return createBlobStorage(driver)
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
    async head(pathname) { return (await resolveStorage(name)).head(pathname) },
    async list(options) { return (await resolveStorage(name)).list(options) },
    async put(pathname, body, options) { return (await resolveStorage(name)).put(pathname, body, options) },
    async serve(event, pathname) { return (await resolveStorage(name)).serve(event, pathname) },
    store(storeName: BlobStoreName) { return createRuntimeBlobStorage(storeName) },
  }
}

export const blob: BlobStorage = createRuntimeBlobStorage()
