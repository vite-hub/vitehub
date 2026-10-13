/// <reference path="../virtual-module.d.ts" />

import * as v from "valibot"

import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText } from "@vite-hub/internal/inspect"
// The package import keeps the Nitro module graph on the storage that `hubKv()` selects, for example the generated
// Cloudflare KV runtime. A relative import would bypass that selection.
import { kv } from "@vite-hub/kv"

import { inspectKVValue, kvValueType } from "./inspect-value.ts"

import { isKVDevOperation, kvDevDefaultListLimit, kvDevHeader, kvDevHeaderValue, kvDevMaximumListLimit } from "../dev.ts"

import type { KVDevRequestBody } from "../dev.ts"
import type { KVDriver, KVResult, KVStorage, ResolvedKVModuleOptions } from "../types.ts"

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

class KVDevRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

const maximumKeyLength = 2_048

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function failure(message: string, status: number, code?: string): Response {
  const error: { code?: string; message: string } = { message: redactInspectionText(message) }
  if (code) error.code = code
  return json({ error }, status)
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

/** Returns the KV stores of this runtime. The dev handler accepts only these store names. */
export function listKVDevStores(): KVDevStore[] {
  return resolvedStores(kvConfig)
}

function errorCode(cause: unknown): string | undefined {
  const code: unknown = cause instanceof Object ? Reflect.get(cause, "code") : undefined
  return v.is(v.string(), code) ? code : undefined
}

function unwrap<TResult>(result: KVResult<TResult>): TResult {
  if (result[0] === null) return result[1]
  const error = result[0]
  const cause = error.cause
  const causeMessage = cause instanceof Error ? ` ${cause.message}` : ""
  throw new KVDevRequestError(`${error.message}${causeMessage}`, 502, errorCode(cause) ?? error.code)
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

function readString(body: Record<string, unknown>, name: string): string | undefined {
  const value: unknown = Reflect.get(body, name)
  if (value === undefined) return
  if (!v.is(v.string(), value)) throw new KVDevRequestError(`${name} must be a string.`, 400)
  return value
}

function readPositiveInteger(body: Record<string, unknown>, name: string): number | undefined {
  const value: unknown = Reflect.get(body, name)
  if (value === undefined) return
  if (!v.is(v.pipe(v.number(), v.integer(), v.minValue(1)), value)) {
    throw new KVDevRequestError(`${name} must be a positive integer.`, 400)
  }
  return value
}

function readTTL(body: unknown): number | undefined {
  const parsed = v.safeParse(v.object({ ttl: v.optional(v.pipe(v.number(), v.finite(), v.gtValue(0))) }), body)
  if (!parsed.success) throw new KVDevRequestError("ttl must be a positive number.", 400)
  return parsed.output.ttl
}

async function readBody(request: Request): Promise<KVDevRequestBody> {
  const body: unknown = await request.json().catch(() => undefined)
  const record = v.safeParse(v.record(v.string(), v.unknown()), body)
  if (!record.success) throw new KVDevRequestError("The KV Dev request body is invalid.", 400)
  const operation: unknown = Reflect.get(record.output, "operation")
  if (!isKVDevOperation(operation)) throw new KVDevRequestError("The KV Dev request body is invalid.", 400)
  const parsed: KVDevRequestBody = { operation }
  const cursor = readString(record.output, "cursor")
  const key = readString(record.output, "key")
  const limit = readPositiveInteger(record.output, "limit")
  const prefix = readString(record.output, "prefix")
  const store = readString(record.output, "store")
  const ttl = readTTL(record.output)
  if (cursor) parsed.cursor = cursor
  if (key !== undefined) parsed.key = key
  if (limit !== undefined) parsed.limit = limit
  if (prefix !== undefined) parsed.prefix = prefix
  if (store !== undefined) {
    if (!store.trim()) throw new KVDevRequestError("store must be a nonempty name.", 400)
    parsed.store = store
  }
  if (ttl !== undefined) parsed.ttl = ttl
  if (Reflect.has(record.output, "value")) parsed.value = Reflect.get(record.output, "value")
  return parsed
}

function selectStore(stores: readonly KVDevStore[], name = "default"): { driver: KVDriver, name: string, storage: KVStorage } {
  if (stores.length === 0) {
    throw new KVDevRequestError("KV is disabled in this runtime. Configure `hubKv()` without `kv: false`.", 409, "KV_DISABLED")
  }
  const store = stores.find(entry => entry.name === name)
  if (!store) {
    throw new KVDevRequestError(`KV store "${name}" was not found. Stores: ${stores.map(entry => entry.name).join(", ")}.`, 404, "KV_STORE_NOT_FOUND")
  }
  return { driver: store.driver, name, storage: name === "default" ? kv : kv.store(name) }
}

function requireKey(body: KVDevRequestBody): string {
  if (body.key === undefined) throw new KVDevRequestError(`The ${body.operation} operation requires a key.`, 400)
  if (body.key.length > maximumKeyLength) throw new KVDevRequestError("The key is too long.", 400)
  return body.key
}

async function runOperation(body: KVDevRequestBody, stores: readonly KVDevStore[]): Promise<unknown> {
  const selected = selectStore(stores, body.store)
  switch (body.operation) {
    case "list": {
      const limit = body.limit ?? kvDevDefaultListLimit
      if (limit > kvDevMaximumListLimit) throw new KVDevRequestError(`limit must be at most ${kvDevMaximumListLimit}.`, 400)
      if ((body.prefix?.length ?? 0) > maximumKeyLength) throw new KVDevRequestError("The prefix is too long.", 400)
      const listOptions: { cursor?: string; limit: number; prefix: string } = { limit, prefix: body.prefix ?? "" }
      if (body.cursor) listOptions.cursor = body.cursor
      const page = unwrap(await selected.storage.list(listOptions))
      const result: KVDevListResult = {
        keys: page.keys,
        limit,
        prefix: body.prefix ?? "",
        store: selected.name,
        stores: stores.map(store => store.name),
      }
      if (page.cursor) result.cursor = page.cursor
      return result
    }
    case "get": {
      const key = requireKey(body)
      const value = unwrap(await selected.storage.get(key))
      const found = value !== null || unwrap(await selected.storage.has(key))
      const result: KVDevGetResult = { found, key, store: selected.name }
      if (!found) return result
      const inspected = inspectKVValue(value)
      if (!inspected) throw new KVDevRequestError("The stored value cannot be represented by the KV inspection protocol.", 422, "KV_VALUE_UNSUPPORTED")
      return { ...result, ...inspected }
    }
    case "has": {
      const key = requireKey(body)
      const result: KVDevHasResult = { exists: unwrap(await selected.storage.has(key)), key, store: selected.name }
      return result
    }
    case "set": {
      const key = requireKey(body)
      if (body.value === undefined) throw new KVDevRequestError("The set operation requires a value.", 400)
      if (selected.driver === "upstash" && body.ttl !== undefined && body.ttl < 1) throw new KVDevRequestError("Upstash TTL must be at least 1 second.", 400)
      const existed = unwrap(await selected.storage.has(key))
      const ttl = body.ttl === undefined ? undefined : selected.driver === "cloudflare-kv-binding" ? Math.max(60, Math.ceil(body.ttl)) : selected.driver === "upstash" ? Math.ceil(body.ttl) : body.ttl
      unwrap(await selected.storage.set(key, body.value, ttl === undefined ? undefined : { ttl }))
      const notice = body.ttl ? ttlNotice(selected.driver, body.ttl) : undefined
      const result: KVDevSetResult = {
        created: !existed,
        key,
        store: selected.name,
        type: kvValueType(body.value),
      }
      if (notice) result.notice = notice
      if (ttl) result.ttl = ttl
      return result
    }
    case "del": {
      const key = requireKey(body)
      const existed = unwrap(await selected.storage.has(key))
      unwrap(await selected.storage.del(key))
      const result: KVDevDeleteResult = { deleted: existed, key, store: selected.name }
      return result
    }
  }
}

/**
 * Handles one KV operation from `vitehub kv`. The Vite Development Server forwards the request into the Nitro
 * runtime, so the operation uses the same KV stores and bindings as the application.
 *
 * The request must carry the KV dev header, must not come from another origin, and must use JSON. There is no
 * operation that clears a store.
 */
export async function handleKVDevRequest(request: Request, stores: readonly KVDevStore[] = listKVDevStores()): Promise<Response> {
  const { rejection } = await validateViteHubNitroDevRequest(request, { header: kvDevHeader, headerValue: kvDevHeaderValue, label: "KV Dev" })
  if (rejection) return rejection
  try {
    return json(await runOperation(await readBody(request), stores))
  }
  catch (error) {
    if (error instanceof KVDevRequestError) return failure(error.message, error.status, error.code)
    return failure(`The KV operation failed: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}
