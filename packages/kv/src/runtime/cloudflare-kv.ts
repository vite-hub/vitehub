import { invariant } from "@vite-hub/internal/invariant"
import { getActiveCloudflareBinding } from "@vite-hub/internal/runtime/cloudflare-env"
import createDriver from "unstorage/drivers/cloudflare-kv-binding"
import { createKVStorage } from "./create-storage.ts"
import { normalizeKVListPrefix } from "./list-prefix.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { createCursorHistory, recordCursor } from "./cursor-history.ts"
import { assertCloudflareKVKey, assertCloudflareKVWrite, installCloudflareKVLimits, validateCloudflareKVBatch } from "./cloudflare-kv-limits.ts"
import { chunks, setItemsOneByOne } from "./batch.ts"

import type { KVPageOptions, KVListPage } from "../types.ts"
import type { KVRuntimeDriver } from "./driver.ts"

interface CloudflareKVNamespace {
  get: (keys: string[], type: "text") => Promise<unknown>
  list: (options: { cursor?: string; limit: number; prefix?: string }) => Promise<unknown>
}

interface CloudflareKVListPage {
  cursor?: string
  keys: Array<{ name: string }>
  list_complete: boolean
}

function isCloudflareKVString(value: unknown): value is string {
  return typeof value === "string"
}

function isCloudflareKVListPage(value: unknown): value is CloudflareKVListPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  // SAFETY: The guard reads only unknown properties and validates every field before returning true.
  const page = value as { cursor?: unknown; keys?: unknown; list_complete?: unknown }
  if (typeof page.list_complete !== "boolean" || !Array.isArray(page.keys)) return false
  if (!page.keys.every(key => {
    if (!key || typeof key !== "object" || Array.isArray(key)) return false
    return isCloudflareKVString(Reflect.get(key, "name"))
  })) return false
  return page.list_complete || (isCloudflareKVString(page.cursor) && page.cursor.length > 0)
}

const cloudflareKVBulkGetKeys = 100
const cloudflareKVMaximumListLimit = 1000

const cloudflareBindingIdentities = new WeakMap<object, number>()
let nextCloudflareBindingIdentity = 0

function cloudflareBindingNamespace(bindingName: unknown, namespaceId: unknown, binding?: unknown): string {
  if (typeof namespaceId === "string" && namespaceId.length > 0) return `cloudflare-kv:id:${namespaceId}`
  if (binding && typeof binding === "object") {
    let identity = cloudflareBindingIdentities.get(binding)
    if (identity === undefined) {
      identity = ++nextCloudflareBindingIdentity
      cloudflareBindingIdentities.set(binding, identity)
    }
    return `cloudflare-kv:object:${identity}`
  }
  return typeof bindingName === "string" ? `cloudflare-kv:binding:${bindingName}` : "cloudflare-kv:default"
}

function createCloudflareDriver(options: Record<string, unknown>): KVRuntimeDriver {
  const bindingName = options.binding
  const namespaceId = options.namespaceId
  const driverOptions = typeof bindingName === "string"
    ? { ...options, get binding() { return getActiveCloudflareBinding<CloudflareKVNamespace>(bindingName) ?? bindingName } }
    : options
  // SAFETY: The unstorage Cloudflare driver supplies getInstance and removeItem; this adapter installs listKeys.
  const driver = createDriver(driverOptions) as KVRuntimeDriver & {
    getInstance: () => CloudflareKVNamespace | Promise<CloudflareKVNamespace>
    removeItem: NonNullable<KVRuntimeDriver["removeItem"]>
  }
  installCloudflareKVLimits(driver)
  driver.validateBatch = validateCloudflareKVBatch
  driver.getItems = async (items) => {
    for (const item of items) assertCloudflareKVKey(item.key)
    const values = new Map<string, string | null>()
    for (const batch of chunks([...new Set(items.map(item => item.key))], cloudflareKVBulkGetKeys)) {
      const page = await (await driver.getInstance()).get(batch, "text")
      if (!(page instanceof Map)) throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: "Cloudflare KV bulk get did not return a Map." })
      for (const key of batch) {
        const value: unknown = page.get(key)
        values.set(key, typeof value === "string" ? value : null)
      }
    }
    return items.map(item => ({ key: item.key, value: values.get(item.key) ?? null }))
  }
  const setItemsOneByOneWithLimits = setItemsOneByOne(driver)
  driver.setItems = async (items, commonOptions) => {
    for (const item of items) assertCloudflareKVWrite(item.key, item.value)
    await setItemsOneByOneWithLimits(items, commonOptions)
  }
  const cursorNamespace = cloudflareBindingNamespace(bindingName, namespaceId)
  const cursorHistories = createCursorHistory(cursorNamespace)
  let disposed = false
  const dispose = driver.dispose
  driver.dispose = async () => {
    disposed = true
    cursorHistories.clear()
    try {
      await dispose?.call(driver)
    }
    finally {
      cursorHistories.clear()
    }
  }
  driver.listKeys = async ({ cursor, limit, prefix = "" }: KVPageOptions): Promise<KVListPage> => {
    invariant(!disposed, "a KV store is open while the app runs, because Nitro disposes it only when it closes")
    const listOptions: { cursor?: string; limit: number; prefix?: string } = { limit: Math.min(limit, cloudflareKVMaximumListLimit) }
    if (cursor) listOptions.cursor = cursor
    if (prefix) listOptions.prefix = prefix
    const activeBinding = typeof bindingName === "string" ? getActiveCloudflareBinding<CloudflareKVNamespace>(bindingName) : undefined
    const requestNamespace = cloudflareBindingNamespace(bindingName, namespaceId, activeBinding)
    const continuation = cursor ? cursorHistories.take(cursor, requestNamespace) : { providerCursor: undefined, history: new Set<string>(), namespace: requestNamespace }
    try {
      if (continuation.providerCursor) listOptions.cursor = continuation.providerCursor
      const cursors = continuation.history
      const page = await (await driver.getInstance()).list(listOptions)
      if (!isCloudflareKVListPage(page)) {
        throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: "Cloudflare KV list returned an invalid page." })
      }
      const result: KVListPage = { keys: page.keys.map((key: { name: string }) => key.name) }
      if (!page.list_complete) {
        invariant(!disposed, "a KV store is open while the app runs, because Nitro disposes it only when it closes")
        if (cursors.has(page.cursor!)) {
          throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: "ViteHub rejected a repeated pagination cursor." })
        }
        if (!recordCursor(cursors, page.cursor!)) {
          throw kvErrorDiagnostics.KV_PROVIDER_INVALID_RESPONSE({ problem: "ViteHub rejected pagination after the cursor history limit was reached." })
        }
        result.cursor = cursorHistories.store(page.cursor!, cursors, requestNamespace)
      }
      cursorHistories.complete(cursor)
      return result
    } catch (error) {
      if (cursor && !disposed) cursorHistories.restore(cursor, continuation)
      throw error
    }
  }
  driver.clear = async (prefix = "") => {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await driver.listKeys({ cursor, limit: cloudflareKVMaximumListLimit, prefix })
      keys.push(...page.keys)
      cursor = page.cursor
    } while (cursor)
    for (const key of keys) await driver.removeItem(key, {})
  }
  return driver
}

export function createCloudflareKVStorage(options: Record<string, unknown>): unknown {
  const driver = createCloudflareDriver(options)
  // SAFETY: createKVStorage returns an extensible storage object; listKeys is installed before it escapes.
  const storage = createKVStorage(driver) as unknown as Record<string, unknown>
  storage.listKeys = (listOptions: KVPageOptions) => driver.listKeys({ ...listOptions, prefix: normalizeKVListPrefix(listOptions.prefix) })
  return storage
}

export default createCloudflareDriver
