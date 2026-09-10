/** A JSON-safe representation of a web Response for durable boundaries. */
export interface SerializedResponse {
  readonly body: {
    readonly data: string
    readonly encoding: "base64"
    readonly mediaType: string
  }
  /** Header entries are kept as pairs so repeated headers are preserved. */
  readonly headers: readonly (readonly [string, string])[]
  readonly status: number
  readonly statusText: string
}

import { hasRuntimeType, isRuntimeObject } from "./internal/runtime-type.ts"

/** Normalize a primitive value into the native Web Response contract. */
export function toResponse(value: unknown): Response {
  if (value instanceof Response) return value
  if (value === undefined) return new Response(null, { status: 204 })
  if (hasRuntimeType(value, "string") || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    // SAFETY: The guards admit only strings, Blob, ArrayBuffer, and views accepted by Response.
    return new Response(value as ConstructorParameters<typeof Response>[0])
  }
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

/** Convert a native Response into a JSON-safe record. The body is fully buffered. */
export async function serializeResponse(response: Response): Promise<SerializedResponse> {
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    body: {
      data: bytesToBase64(bytes),
      encoding: "base64",
      mediaType: response.headers.get("content-type") || "application/octet-stream",
    },
    headers: Array.from(response.headers, ([name, value]) => [name, value] as const),
    status: response.status,
    statusText: response.statusText,
  }
}

/** Reconstruct a native Response from a durable response record. */
export function deserializeResponse(value: SerializedResponse): Response {
  if (!isSerializedResponse(value)) throw new TypeError("Invalid serialized Response")
  const bytes = base64ToBytes(value.body.data)
  const body = [204, 205, 304].includes(value.status) && bytes.length === 0 ? null : bytes
  return new Response(body, {
    headers: value.headers.map(([name, headerValue]): [string, string] => [name, headerValue]),
    status: value.status,
    statusText: value.statusText,
  })
}

export function isSerializedResponse(value: unknown): value is SerializedResponse {
  if (!isRuntimeObject(value)) return false
  // SAFETY: isRuntimeObject establishes an object record for property inspection.
  const record = value as Record<string, unknown>
  if (!isRuntimeObject(record.body)) return false
  // SAFETY: isRuntimeObject establishes an object record for property inspection.
  const body = record.body as Record<string, unknown>
  if (!hasRuntimeType(body.data, "string") || body.encoding !== "base64" || !hasRuntimeType(body.mediaType, "string")) return false
  if (!hasRuntimeType(record.status, "number") || !Number.isInteger(record.status) || record.status < 200 || record.status > 599) return false
  if (!hasRuntimeType(record.statusText, "string") || !Array.isArray(record.headers)) return false
  return record.headers.every((entry) => Array.isArray(entry) && entry.length === 2 && hasRuntimeType(entry[0], "string") && hasRuntimeType(entry[1], "string"))
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
