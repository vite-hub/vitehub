import { createStorage, prefixStorage } from "unstorage"

import { normalizeSafeSourcePath } from "./core/path.ts"

import type { Driver, StorageValue } from "unstorage"
import type { Source } from "./core/types.ts"

export interface UnstorageSourceOptions {
  driver: Driver
  mediaType?: string
  prefix?: string
}

function sourceContent(value: StorageValue): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function sourceKey(key: string): string {
  return normalizeSafeSourcePath(key.replace(/:/g, "/"))
}

function storageKey(key: string): string {
  return normalizeSafeSourcePath(key).replace(/\//g, ":")
}

/** Expose any unstorage driver as a ViteHub Source. */
export function unstorage(options: UnstorageSourceOptions): Source {
  const rootStorage = createStorage({ driver: options.driver })
  const storage = options.prefix ? prefixStorage(rootStorage, options.prefix) : rootStorage

  return {
    fingerprint: {
      driver: options.driver.name,
      prefix: options.prefix,
    },
    name: "unstorage",
    async getKeys() {
      return (await storage.getKeys()).map(sourceKey)
    },
    async getItem(key) {
      const normalizedKey = sourceKey(key)
      const value = await storage.getItem(storageKey(normalizedKey))
      if (value === null) throw new TypeError(`[vitehub] unstorage() could not find ${JSON.stringify(key)}.`)
      return {
        content: sourceContent(value),
        ...(typeof value === "string" ? {} : { data: value }),
        key: normalizedKey,
        ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
        metadata: await storage.getMeta(storageKey(normalizedKey)),
        path: normalizedKey,
      }
    },
    async getMeta(key) {
      return await storage.getMeta(storageKey(key))
    },
  }
}
