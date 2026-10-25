import "../virtual-module.d.ts"

import { normalizeKey } from "unstorage"
import { redactInspectionText } from "@vite-hub/internal/inspect"
// The package import keeps the Nitro module graph on the storage that `hubKv()` selects, for example the generated
// Cloudflare KV runtime. A relative import would bypass that selection.
import { kv } from "@vite-hub/kv"

import { inspectKVValue, kvValueType } from "./inspect-value.ts"

import { previewKVValue } from "./preview.ts"

import { kvDevDefaultListLimit, kvDevMaximumListLimit } from "../results.ts"

import type { Result } from "@vite-hub/runtime"

import type { KVDriver, KVStorage, ResolvedKVModuleOptions } from "../types.ts"

function isMissingKVConfig(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined
  const message = error instanceof Error ? error.message : ""
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return /^Cannot find (?:package|module) ["']#vitehub\/kv\/config["']/.test(message)
  }
  if (code === "ERR_PACKAGE_IMPORT_NOT_DEFINED") {
    return /^Package import specifier ["']#vitehub\/kv\/config["'] is not defined/.test(message)
  }
  return false
}

let kvConfig: false | ResolvedKVModuleOptions = false
try {
  const config = await import("#vitehub/kv/config")
  kvConfig = config.kv
}
catch (error) {
  if (!isMissingKVConfig(error)) throw error
}

/** Store names and drivers that the KV configuration of this runtime defines. `default` is first. */
export interface KVDevStore {
  driver: KVDriver
  name: string
}

export interface KVDevListResult {
  /** Present when more keys exist. Pass it as `--cursor` to read the next page. */
  cursor?: string
  keys: string[]
  limit: number
  prefix: string
  store: string
  stores: string[]
}

export interface KVDevGetResult {
  /** `base64` when the stored value is binary. `value` is then the base64 text. */
  encoding?: "base64"
  found: boolean
  /** With `preview`: how `value` is written. */
  format?: "json" | "text"
  /**
   * Whether the key can expire. `none`: the store never expires keys (fs-lite ignores TTL). `unknown`: the store can
   * expire keys, but its driver cannot report the time left, so a write that sets no TTL removes the expiry.
   */
  expiry?: "none" | "unknown"
  /** With `preview`: the value was cut at 256 KiB. */
  truncated?: true
  key: string
  store: string
  /** JavaScript type of the stored value, for example `string`, `object`, `number`, or `bytes`. */
  type?: string
  value?: unknown
}

export interface KVDevHasResult {
  exists: boolean
  key: string
  store: string
}

export interface KVDevSetResult {
  /** `true` when the key did not exist before the write. */
  created: boolean
  key: string
  /** Limit of the provider that the write is subject to, for example a TTL that the driver ignores. */
  notice?: string
  store: string
  /** Effective TTL in seconds passed to the driver. */
  ttl?: number
  type: string
}

export interface KVDevDeleteResult {
  /** `true` when the key was found before the delete. */
  deleted: boolean
  key: string
  store: string
}

/** The input of a `kv.*` operation, after the schema checked it. */
export interface KVOperationInput {
  cursor?: string
  key?: string
  limit?: number
  prefix?: string
  /** `kv.get`: format the value as text of at most 256 KiB, as the Console shows it. */
  preview?: boolean
  /** Store name. Defaults to `default`. */
  store?: string
  /** Time to live in seconds for `set`. */
  ttl?: number
  value?: unknown
}

/** A failure with the fields that every surface reports. */
export class KVOperationError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly fix?: string) {
    super(redactInspectionText(message))
  }
}

const maximumKeyLength = 2_048

function unwrap<TResult>(result: Result<TResult>): TResult {
  const [error, value] = result
  if (!error) return value
  const cause = error.code === "KV_OPERATION_FAILED" && error.cause instanceof Error ? ` ${error.cause.message}` : ""
  throw new KVOperationError(`${error.message}${cause}`, error.code === "KV_INVALID_CURSOR" ? 400 : 502, error.code)
}

function resolvedStores(config: false | ResolvedKVModuleOptions): KVDevStore[] {
  if (!config) return []
  const stores = Object.entries(config.stores ?? { default: config.store })
    .map(([name, store]) => ({ driver: store.driver, name }))
  return [
    ...stores.filter(store => store.name === "default"),
    ...stores.filter(store => store.name !== "default").sort((left, right) => left.name.localeCompare(right.name)),
  ]
}

/** Returns the KV stores of this runtime. The operations accept only these store names. */
export function listKVDevStores(): KVDevStore[] {
  return resolvedStores(kvConfig)
}

function ttlNotice(driver: KVDriver, ttl: number): string | undefined {
  if (driver === "fs-lite") return "The fs-lite driver ignores TTL. The value does not expire."
  if (driver === "upstash" && Math.ceil(ttl) !== ttl) return `Upstash rounds the TTL up to ${Math.ceil(ttl)} seconds.`
  if (driver === "cloudflare-kv-binding") {
    const effectiveTTL = Math.max(60, Math.ceil(ttl))
    if (ttl < 60) return "Cloudflare KV raises a TTL below 60 seconds to 60 seconds."
    if (effectiveTTL !== ttl) return `Cloudflare KV rounds the TTL up to ${effectiveTTL} seconds.`
  }
}

function selectStore(stores: readonly KVDevStore[], name = "default"): { driver: KVDriver, name: string, storage: KVStorage } {
  if (stores.length === 0) {
    throw new KVOperationError("KV is disabled in this runtime. Configure `hubKv()` without `kv: false`.", 409, "KV_DISABLED", "Enable KV with hubKv() or vitehub({ kv: true }).")
  }
  const store = stores.find(entry => entry.name === name)
  if (!store) {
    throw new KVOperationError(`KV store "${name}" was not found. Stores: ${stores.map(entry => entry.name).join(", ")}.`, 404, "KV_STORE_NOT_FOUND")
  }
  return { driver: store.driver, name, storage: name === "default" ? kv : kv.store(name) }
}

/** The keys under `vitehub:` belong to ViteHub, which keeps its own state there. */
function requireWritableKey(operation: string, key: string): void {
  if (!normalizeKey(key).toLowerCase().startsWith("vitehub:")) return
  throw new KVOperationError(`The ${operation} operation cannot change ${key}. ViteHub owns the keys that start with \`vitehub:\`.`, 403, "KV_RESERVED_KEY", "Use another key. Read access (get, has, list) stays open.")
}

function requireKey(operation: string, input: KVOperationInput): string {
  if (input.key === undefined) throw new KVOperationError(`The ${operation} operation requires a key.`, 400, "KV_INVALID_INPUT")
  if (input.key.length > maximumKeyLength) throw new KVOperationError("The key is too long.", 400, "KV_INVALID_INPUT")
  return input.key
}

/**
 * Runs one `kv.*` operation against the KV stores of this runtime. The Nitro runtime owns the stores and their
 * bindings, so this runs where the app does. There is no operation that clears a store.
 */
export async function runKVOperation(operation: "list" | "get" | "has" | "set" | "del", input: KVOperationInput, stores: readonly KVDevStore[] = listKVDevStores()): Promise<unknown> {
  const selected = selectStore(stores, input.store)
  switch (operation) {
    case "list": {
      const limit = input.limit ?? kvDevDefaultListLimit
      if (limit > kvDevMaximumListLimit) throw new KVOperationError(`limit must be at most ${kvDevMaximumListLimit}.`, 400, "KV_INVALID_INPUT")
      if ((input.prefix?.length ?? 0) > maximumKeyLength) throw new KVOperationError("The prefix is too long.", 400, "KV_INVALID_INPUT")
      const listOptions: { cursor?: string, limit: number, prefix: string } = { limit, prefix: input.prefix ?? "" }
      if (input.cursor) listOptions.cursor = input.cursor
      const page = unwrap(await selected.storage.list(listOptions))
      const result: KVDevListResult = {
        keys: page.keys,
        limit,
        prefix: input.prefix ?? "",
        store: selected.name,
        stores: stores.map(store => store.name),
      }
      if (page.cursor) result.cursor = page.cursor
      return result
    }
    case "get": {
      const key = requireKey(operation, input)
      const value = unwrap(await selected.storage.get(key))
      const found = value !== null || unwrap(await selected.storage.has(key))
      const result: KVDevGetResult = { found, key, store: selected.name }
      if (found) result.expiry = selected.driver === "fs-lite" ? "none" : "unknown"
      if (!found) return result
      if (input.preview) return { ...result, ...previewKVValue(value) } satisfies KVDevGetResult
      const inspected = inspectKVValue(value)
      if (!inspected) throw new KVOperationError("The stored value cannot be represented by the KV inspection protocol.", 422, "KV_VALUE_UNSUPPORTED")
      return { ...result, ...inspected }
    }
    case "has": {
      const key = requireKey(operation, input)
      const result: KVDevHasResult = { exists: unwrap(await selected.storage.has(key)), key, store: selected.name }
      return result
    }
    case "set": {
      const key = requireKey(operation, input)
      requireWritableKey(operation, key)
      if (input.value === undefined) throw new KVOperationError("The set operation requires a value.", 400, "KV_INVALID_INPUT")
      if (selected.driver === "upstash" && input.ttl !== undefined && input.ttl < 1) throw new KVOperationError("Upstash TTL must be at least 1 second.", 400, "KV_INVALID_INPUT")
      const existed = unwrap(await selected.storage.has(key))
      const ttl = input.ttl === undefined ? undefined : selected.driver === "cloudflare-kv-binding" ? Math.max(60, Math.ceil(input.ttl)) : selected.driver === "upstash" ? Math.ceil(input.ttl) : input.ttl
      unwrap(await selected.storage.set(key, input.value, ttl === undefined ? undefined : { ttl }))
      const notice = input.ttl ? ttlNotice(selected.driver, input.ttl) : undefined
      const result: KVDevSetResult = {
        created: !existed,
        key,
        store: selected.name,
        type: kvValueType(input.value),
      }
      if (notice) result.notice = notice
      if (ttl) result.ttl = ttl
      return result
    }
    case "del": {
      const key = requireKey(operation, input)
      requireWritableKey(operation, key)
      const existed = unwrap(await selected.storage.has(key))
      unwrap(await selected.storage.del(key))
      const result: KVDevDeleteResult = { deleted: existed, key, store: selected.name }
      return result
    }
  }
}
