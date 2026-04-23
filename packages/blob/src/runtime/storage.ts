import { createBlobStorage } from "../storage.ts"
import { resolveRuntimeVercelBlobStore } from "../config.ts"

import { getBlobRuntimeConfig, getBlobRuntimeStorage, setBlobRuntimeStorage } from "./state.ts"

import type { BlobStorage, ResolvedBlobModuleOptions, ResolvedBlobStoreConfig } from "../types.ts"

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

async function resolveStorage() {
  const existing = getBlobRuntimeStorage()
  if (existing) {
    return existing
  }

  const config = await getBlobRuntimeConfig()
  if (!config) {
    throw new Error("Blob runtime is disabled.")
  }

  const storage = await createConfiguredBlobStorage(config)
  setBlobRuntimeStorage(storage)
  return storage
}

export const blob: BlobStorage = {
  async delete(pathnames) { await (await resolveStorage()).delete(pathnames) },
  async del(pathnames) { await (await resolveStorage()).del(pathnames) },
  async get(pathname) { return (await resolveStorage()).get(pathname) },
  async head(pathname) { return (await resolveStorage()).head(pathname) },
  async list(options) { return (await resolveStorage()).list(options) },
  async put(pathname, body, options) { return (await resolveStorage()).put(pathname, body, options) },
  async serve(event, pathname) { return (await resolveStorage()).serve(event, pathname) },
}
