import { assertConsoleRequest, consoleRequestURL } from "./request.ts"
import { getConsoleKV } from "./kv.ts"

import type { KVResult, KVStorage } from "@vite-hub/kv"
import type { ConsoleRequestEvent } from "./request.ts"

const defaultLimit = 200
const maximumLimit = 500
const maximumKeyLength = 2_048
const maximumValueBytes = 256 * 1_024

interface ConsoleKVValue {
  found: boolean
  format?: "json" | "text"
  key: string
  store: string
  truncated?: boolean
  type?: string
  value?: string
}

function requestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(new Error(statusMessage), { statusCode, statusMessage })
}

function requiredParameter(value: string | null, name: string): string {
  if (value === null || value.length === 0) throw requestError(400, `${name} is required.`)
  if (value.length > maximumKeyLength) throw requestError(400, `${name} is too long.`)
  return value
}

function limitParameter(value: string | null): number {
  if (value === null || value === "") return defaultLimit
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximumLimit) {
    throw requestError(400, `limit must be an integer from 1 to ${maximumLimit}.`)
  }
  return parsed
}

function unwrap<TResult>(result: KVResult<TResult>): TResult {
  if (result[0]) throw requestError(502, result[0].message)
  return result[1]
}

function valueType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (value instanceof Uint8Array) return "bytes"
  return typeof value
}

function truncateValue(value: string): { truncated: boolean; value: string } {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maximumValueBytes) return { truncated: false, value }
  let bytes = 0
  let end = 0
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > maximumValueBytes) break
    bytes += characterBytes
    end += character.length
  }
  return { truncated: true, value: value.slice(0, end) }
}

function formatValue(value: unknown): Pick<ConsoleKVValue, "format" | "truncated" | "type" | "value"> {
  const type = valueType(value)
  let format: "json" | "text" = "json"
  let rendered: string
  if (typeof value === "string") {
    format = "text"
    rendered = value
  }
  else if (value instanceof Uint8Array) {
    format = "text"
    rendered = Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")
  }
  else {
    try {
      rendered = JSON.stringify(value, null, 2) ?? String(value)
    }
    catch {
      format = "text"
      rendered = String(value)
    }
  }
  const result = truncateValue(rendered)
  return {
    format,
    type,
    value: result.value,
    ...(result.truncated ? { truncated: true } : {}),
  }
}

function selectStore(storage: KVStorage, stores: readonly string[], requested: string | null): { name: string; storage: KVStorage } {
  const name = requested === null || requested === "" ? "default" : requested
  if (!stores.includes(name)) throw requestError(404, "KV store not found.")
  return { name, storage: name === "default" ? storage : storage.store(name) }
}

export default async function consoleKVHandler(event: ConsoleRequestEvent): Promise<
  | ConsoleKVValue
  | { keys: string[]; limit: number; prefix: string; store: string; stores: readonly string[]; total: number; truncated: boolean }
> {
  assertConsoleRequest(event)
  const url = consoleRequestURL(event)
  const inspection = getConsoleKV()
  const selected = selectStore(inspection.storage, inspection.stores, url.searchParams.get("store"))
  const requestedKey = url.searchParams.get("key")

  if (requestedKey !== null) {
    const key = requiredParameter(requestedKey, "key")
    const value = unwrap(await selected.storage.get(key))
    const found = value !== null || unwrap(await selected.storage.has(key))
    return {
      found,
      key,
      store: selected.name,
      ...(found ? formatValue(value) : {}),
    }
  }

  const prefix = url.searchParams.get("prefix") ?? ""
  if (prefix.length > maximumKeyLength) throw requestError(400, "prefix is too long.")
  const limit = limitParameter(url.searchParams.get("limit"))
  const allKeys = [...new Set(unwrap(await selected.storage.keys(prefix)))].sort((left, right) => left.localeCompare(right))
  return {
    keys: allKeys.slice(0, limit),
    limit,
    prefix,
    store: selected.name,
    stores: inspection.stores,
    total: allKeys.length,
    truncated: allKeys.length > limit,
  }
}
