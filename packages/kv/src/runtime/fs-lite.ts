import type { Driver } from "unstorage"
import fsLite from "unstorage/drivers/fs-lite"

import type { ResolvedFsLiteKVStoreConfig } from "../types.ts"

const segmentPrefix = "~"
const valueSuffix = ".value"

function encodeKey(key: string) {
  const segments = key
    .split(":")
    .map(segment => `${segmentPrefix}${encodeURIComponent(segment)}`)
  return `${segments.slice(0, -1).join("/")}${segments.length > 1 ? "/" : ""}${segments.at(-1)}${valueSuffix}`
}

function decodeKey(key: string) {
  const segments = key.split("/")
  const leaf = segments.pop()
  if (
    !leaf?.startsWith(segmentPrefix) ||
    !leaf.endsWith(valueSuffix) ||
    !segments.every(segment => segment.startsWith(segmentPrefix))
  )
    return
  segments.push(leaf.slice(0, -valueSuffix.length))
  try {
    return segments
      .map(segment => decodeURIComponent(segment.slice(segmentPrefix.length)))
      .join(":")
  } catch {
    return
  }
}

export function createFsLiteKVRuntimeDriver(store: ResolvedFsLiteKVStoreConfig): Driver {
  const driver = fsLite(store)
  return {
    ...driver,
    async clear(base = "", options) {
      if (!base) return driver.clear?.(base, options)
      await Promise.all(
        ((await driver.getKeys("", options)) || [])
          .filter(key => (decodeKey(key) || key).startsWith(base))
          .map(key => driver.removeItem?.(key, options)),
      )
    },
    async getItem(key, options) {
      return (
        (await driver.getItem?.(encodeKey(key), options)) ?? driver.getItem?.(key, options) ?? null
      )
    },
    async getItemRaw(key, options) {
      return (
        (await driver.getItemRaw?.(encodeKey(key), options)) ??
        driver.getItemRaw?.(key, options) ??
        null
      )
    },
    async getKeys(base = "", options) {
      return [
        ...new Set(
          ((await driver.getKeys?.("", options)) || [])
            .map(key => decodeKey(key) || key)
            .filter(key => key.startsWith(base)),
        ),
      ]
    },
    async getMeta(key, options) {
      return ((await driver.hasItem(encodeKey(key), options))
        ? driver.getMeta?.(encodeKey(key), options)
        : driver.getMeta?.(key, options)) ?? null
    },
    async hasItem(key, options) {
      return Boolean(
        (await driver.hasItem?.(encodeKey(key), options)) || (await driver.hasItem?.(key, options)),
      )
    },
    async removeItem(key, options) {
      await Promise.all([
        driver.removeItem?.(encodeKey(key), options),
        driver.removeItem?.(key, options),
      ])
    },
    async setItem(key, value, options) {
      await driver.setItem?.(encodeKey(key), value, options)
    },
    async setItemRaw(key, value, options) {
      await driver.setItemRaw?.(encodeKey(key), value, options)
    },
  }
}
