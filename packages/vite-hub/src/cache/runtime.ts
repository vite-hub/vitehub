import { useStorage } from "nitro/storage"

import { deleteCacheEntries, getCacheEntry, listCacheEntries } from "./entries.ts"

import type { CacheDeleteResult, CacheGetResult, CacheListResult } from "./entries.ts"

/** Nitro's `cache` mount, where `defineCachedFunction()` and `defineCachedHandler()` keep their entries. */
const storage = () => useStorage("cache")

export const listCache = (input: { cursor?: string, limit?: number, prefix?: string }): Promise<CacheListResult> => listCacheEntries(storage(), input)
export const getCache = (input: { key: string }): Promise<CacheGetResult> => getCacheEntry(storage(), input)
export const deleteCache = (input: { key?: string, prefix?: string }): Promise<CacheDeleteResult> => deleteCacheEntries(storage(), input)
