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
  if (value === null) throw requestError(400, `${name} is required.`)
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
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The type label intentionally reports the remaining JavaScript primitive representation.
  return typeof value
}

function truncateValue(value: string): { truncated: boolean; value: string } {
  const encoder = new TextEncoder()
  let bytes = 0
  let end = 0
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > maximumValueBytes) {
      return { truncated: true, value: value.slice(0, end) }
    }
    bytes += characterBytes
    end += character.length
  }
  return { truncated: false, value }
}

function boundedJSONStringify(value: unknown): { truncated: boolean; value?: string } {
  let bytes = 0
  let rendered = ""
  let truncated = false
  const encoder = new TextEncoder()
  const ancestors = new Set<object>()

  function append(fragment: string): boolean {
    for (const character of fragment) {
      const characterBytes = encoder.encode(character).byteLength
      if (bytes + characterBytes > maximumValueBytes) {
        truncated = true
        return false
      }
      rendered += character
      bytes += characterBytes
    }
    return true
  }

  function appendString(text: string): boolean {
    if (!append('"')) return false
    for (const character of text) {
      const escaped = JSON.stringify(character).slice(1, -1)
      if (!append(escaped)) return false
    }
    return append('"')
  }

  function serialize(input: unknown, depth: number, arrayValue: boolean): boolean {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON value categories are selected at this serialization boundary.
    if (typeof input === "string") return appendString(input)
    if (input === null) return append("null")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON value categories are selected at this serialization boundary.
    if (typeof input === "number") return append(Number.isFinite(input) ? String(input) : "null")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON value categories are selected at this serialization boundary.
    if (typeof input === "boolean") return append(input ? "true" : "false")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON omits these values in objects and writes null for them in arrays.
    if (typeof input === "undefined" || typeof input === "function" || typeof input === "symbol") {
      return arrayValue ? append("null") : false
    }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON.stringify throws for bigint values.
    if (typeof input === "bigint") throw new TypeError("Cannot serialize bigint as JSON.")

    // SAFETY: Primitive JSON categories returned above, so the remaining input is an object.
    const object = input as object & { toJSON?: () => unknown }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The optional method is validated before invocation.
    if (typeof object.toJSON === "function") {
      const replacement = object.toJSON()
      if (replacement !== input) return serialize(replacement, depth, arrayValue)
    }
    if (ancestors.has(object)) throw new TypeError("Cannot serialize a circular value as JSON.")
    ancestors.add(object)

    if (Array.isArray(object)) {
      if (!append("[")) return false
      for (let index = 0; index < object.length; index += 1) {
        if (!append(`${index === 0 ? "" : ","}\n${"  ".repeat(depth + 1)}`)) return false
        if (!serialize(object[index], depth + 1, true)) return false
      }
      if (object.length > 0 && !append(`\n${"  ".repeat(depth)}`)) return false
      ancestors.delete(object)
      return append("]")
    }

    if (!append("{")) return false
    let count = 0
    for (const key in object) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue
      // SAFETY: The own enumerable key came from this object, whose property values remain unknown.
      const item = (object as Record<string, unknown>)[key]
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- JSON omits unsupported object property values.
      if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") continue
      if (!append(`${count === 0 ? "" : ","}\n${"  ".repeat(depth + 1)}`)) return false
      if (!appendString(key) || !append(": ") || !serialize(item, depth + 1, false)) return false
      count += 1
    }
    if (count > 0 && !append(`\n${"  ".repeat(depth)}`)) return false
    ancestors.delete(object)
    return append("}")
  }

  const serialized = serialize(value, 0, false)
  return { truncated, value: serialized || truncated ? rendered : undefined }
}

function formatValue(value: unknown): Pick<ConsoleKVValue, "format" | "truncated" | "type" | "value"> {
  const type = valueType(value)
  let format: "json" | "text" = "json"
  let rendered: string
  let truncated = false
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- KV drivers return unknown values, so string identity is validated at this formatting boundary.
  if (typeof value === "string") {
    format = "text"
    rendered = value
  }
  else if (value instanceof Uint8Array) {
    format = "text"
    const maximumBytes = maximumValueBytes / 2
    truncated = value.byteLength > maximumBytes
    rendered = Array.from(value.subarray(0, maximumBytes), byte => byte.toString(16).padStart(2, "0")).join("")
  }
  else {
    try {
      const result = boundedJSONStringify(value)
      rendered = result.value ?? String(value)
      truncated = result.truncated
    }
    catch {
      format = "text"
      rendered = String(value)
    }
  }
  const result = truncateValue(rendered)
  const formatted: Pick<ConsoleKVValue, "format" | "truncated" | "type" | "value"> = {
    format,
    type,
    value: result.value,
  }
  if (truncated || result.truncated) formatted.truncated = true
  return formatted
}

function selectStore(storage: KVStorage, stores: readonly string[], requested: string | null): { name: string; storage: KVStorage } {
  const name = requested === null || requested === "" ? "default" : requested
  if (!stores.includes(name)) throw requestError(404, "KV store not found.")
  return { name, storage: name === "default" ? storage : storage.store(name) }
}

export default async function consoleKVHandler(event: ConsoleRequestEvent): Promise<
  | ConsoleKVValue
  | { cursor?: string; keys: string[]; limit: number; prefix: string; store: string; stores: readonly string[] }
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
    const response: ConsoleKVValue = {
      found,
      key,
      store: selected.name,
    }
    if (found) Object.assign(response, formatValue(value))
    return response
  }

  const prefix = url.searchParams.get("prefix") ?? ""
  if (prefix.length > maximumKeyLength) throw requestError(400, "prefix is too long.")
  const limit = limitParameter(url.searchParams.get("limit"))
  const cursor = url.searchParams.get("cursor") || undefined
  const page = unwrap(await selected.storage.list({ cursor, limit, prefix }))
  const response = {
    keys: page.keys,
    limit,
    prefix,
    store: selected.name,
    stores: inspection.stores,
  }
  return page.cursor ? { ...response, cursor: page.cursor } : response
}
