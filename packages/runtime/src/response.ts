/** A JSON-safe representation of a web Response for durable boundaries. */
export interface SerializedResponse {
  readonly body: {
    readonly data: string
    readonly encoding: "base64"
    readonly mediaType: string
    readonly isNull?: boolean
  }
  /** Header entries are kept as pairs so repeated headers are preserved. */
  readonly headers: readonly (readonly [string, string])[]
  readonly status: number
  readonly statusText: string
  readonly url?: string
  readonly type?: "error" | "opaque" | "opaqueredirect"
}

import { hasRuntimeType, isRuntimeObject } from "./internal/runtime-type.ts"

interface BlobMethods {
  readonly stream: () => ReadableStream
  readonly type: string
}

function getBlobMethods(value: unknown): BlobMethods | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined
  try {
    let prototype = Object.getPrototypeOf(value)
    while (prototype) {
      const sliceDescriptor = Object.getOwnPropertyDescriptor(prototype, "slice")
      // Resolve the stream from a Blob returned by the brand-checked slice.
      // This skips own and prototype-level stream overrides on the input.
      if (!sliceDescriptor) {
        prototype = Object.getPrototypeOf(prototype)
        continue
      }
      const slice = sliceDescriptor.value
      if (!hasRuntimeType(slice, "function")) {
        prototype = Object.getPrototypeOf(prototype)
        continue
      }
      try {
        const sliced: unknown = Reflect.apply(slice, value, [0, 0])
        // A real Blob slice always creates a distinct Blob. Reject methods
        // that simply return their receiver, which can otherwise imitate the
        // prototype checks below without carrying Blob internal slots.
        if (sliced === value) {
          prototype = Object.getPrototypeOf(prototype)
          continue
        }
        if (sliced === null || (typeof sliced !== "object" && typeof sliced !== "function")) {
          prototype = Object.getPrototypeOf(prototype)
          continue
        }
        const slicedPrototype = Object.getPrototypeOf(sliced)
        const constructor = slicedPrototype && Object.getOwnPropertyDescriptor(slicedPrototype, "constructor")?.value
        const slicedSlice = slicedPrototype && Object.getOwnPropertyDescriptor(slicedPrototype, "slice")?.value
        const stream = slicedPrototype && Object.getOwnPropertyDescriptor(slicedPrototype, "stream")?.value
        const sizeGetter = slicedPrototype && Object.getOwnPropertyDescriptor(slicedPrototype, "size")?.get
        const constructorSource = hasRuntimeType(constructor, "function")
          ? Function.prototype.toString.call(constructor)
          : ""
        if (
          !hasRuntimeType(constructor, "function") || constructor.name !== "Blob" ||
          // Native Blob implementations expose the intrinsic methods. The
          // fallback implementation used by tests is a full Blob class; a
          // small user-defined `class Blob` with forged methods is rejected.
          !(constructorSource.includes("[native code]") ||
            (constructorSource.startsWith("class Blob") && constructorSource.length > 1000 &&
              constructorSource.includes("get size") && constructorSource.includes("stream"))) ||
          constructor.prototype !== slicedPrototype ||
          slicedSlice !== slice || !hasRuntimeType(stream, "function") || !hasRuntimeType(sizeGetter, "function")
        ) {
          prototype = Object.getPrototypeOf(prototype)
          continue
        }
        // Applying the same slice operation to its result confirms that the
        // returned object carries the Blob's internal slots, rather than being
        // an arbitrary object returned by a spoofed slice method.
        const slicedAgain = Reflect.apply(slicedSlice, sliced, [0, 0])
        if (slicedAgain === sliced) {
          prototype = Object.getPrototypeOf(prototype)
          continue
        }
        const size = Reflect.apply(sizeGetter, sliced, [])
        const slicedType = Reflect.getOwnPropertyDescriptor(sliced, "type")
        const typeGetter = slicedPrototype && Object.getOwnPropertyDescriptor(slicedPrototype, "type")?.get
        if (
          size !== 0 ||
          (slicedType && !hasRuntimeType(slicedType.value, "string")) ||
          (!slicedType && !hasRuntimeType(typeGetter, "function"))
        ) {
          prototype = Object.getPrototypeOf(prototype)
          continue
        }
        const type = typeGetter
          ? String(Reflect.apply(typeGetter, value, []))
          : String(Reflect.getOwnPropertyDescriptor(value, "type")?.value ?? "")
        return {
          stream: () => Reflect.apply(stream, value, []) as ReadableStream,
          type,
        }
      }
      catch {
        // Continue to the next prototype in the chain.
      }
      prototype = Object.getPrototypeOf(prototype)
    }
    return undefined
  }
  catch {
    return undefined
  }
}

/** Normalize a primitive value into the native Web Response contract. */
export function toResponse(value: unknown): Response {
  if (value instanceof Response) return value
  if (value === undefined) return new Response(null, { status: 204 })
  if (hasRuntimeType(value, "string") || value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    // SAFETY: The guards admit only strings, Blob, ArrayBuffer, and views accepted by Response.
    return new Response(value as ConstructorParameters<typeof Response>[0])
  }
  const blobMethods = getBlobMethods(value)
  if (blobMethods) {
    const type = blobMethods.type
    return new Response(blobMethods.stream(), type ? { headers: { "content-type": type } } : undefined)
  }
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

/** Convert a native Response into a JSON-safe record. The body is fully buffered. */
export async function serializeResponse(response: Response): Promise<SerializedResponse> {
  const isNull = response.body === null
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    body: {
      data: bytesToBase64(bytes),
      isNull,
      encoding: "base64",
      mediaType: response.headers.get("content-type") || "application/octet-stream",
    },
    headers: Array.from(response.headers, ([name, value]) => [name, value] as const),
    status: response.status,
    statusText: response.statusText,
    ...(response.type === "opaqueredirect" ? { url: response.url } : {}),
    ...((response.type === "error" || response.type === "opaque" || response.type === "opaqueredirect") ? { type: response.type } : {}),
  }
}

/** Reconstruct a native Response from a durable response record. */
export function deserializeResponse(value: SerializedResponse): Response {
  if (!isSerializedResponse(value)) throw new TypeError("Invalid serialized Response")
  if (value.type !== undefined) return createStatusZeroResponse(value.type, value.url)
  const bytes = base64ToBytes(value.body.data)
  const body = value.body.isNull === true || ([204, 205, 304].includes(value.status) && bytes.length === 0) ? null : bytes
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
  if (body.isNull !== undefined && !hasRuntimeType(body.isNull, "boolean")) return false
  if (body.isNull === true && body.data !== "") return false
  if (record.url !== undefined && !hasRuntimeType(record.url, "string")) return false
  if (record.type !== undefined && record.type !== "error" && record.type !== "opaque" && record.type !== "opaqueredirect") return false
  if (record.type !== undefined) {
    if (record.type !== "opaqueredirect" && record.url !== undefined) return false
    return record.status === 0 && record.statusText === "" && Array.isArray(record.headers)
      && record.headers.length === 0 && body.isNull === true && body.data === ""
  }
  if (record.url !== undefined) return false
  if (!hasRuntimeType(record.status, "number") || !Number.isInteger(record.status) || record.status < 200 || record.status > 599) return false
  if (!hasRuntimeType(record.statusText, "string") || !isSerializedHeaderEntries(record.headers)) return false
  // Responses with these status codes cannot carry a body. Reject malformed
  // records before deserialization would pass bytes to the native constructor.
  // atob ignores ASCII whitespace, so whitespace-only legacy data has no bytes.
  if ([204, 205, 304].includes(record.status) && (/[^\t\n\f\r ]/.test(body.data) || body.isNull === false)) return false
  const headers = record.headers
  if (!isBase64(body.data)) return false
  try {
    // Keep validation aligned with the native constructor used by deserialization.
    new Response(null, {
      headers: headers.map(([name, headerValue]): [string, string] => [name, headerValue]),
      status: record.status,
      statusText: record.statusText,
    })
  }
  catch {
    return false
  }
  return true
}

function isSerializedHeaderEntry(value: unknown): value is readonly [string, string] {
  return Array.isArray(value) && value.length === 2 && hasRuntimeType(value[0], "string") && hasRuntimeType(value[1], "string")
}

function isSerializedHeaderEntries(value: unknown): value is readonly (readonly [string, string])[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    if (!isSerializedHeaderEntry(value[index])) return false
  }
  return true
}

function isBase64(value: string): boolean {
  const compact = value.replace(/[\t\n\f\r ]/g, "")
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(compact)
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

// The Web API cannot construct opaque responses. Use the native status-zero,
// null-body response and preserve the durable type and visible URL on it and its clones.
function createStatusZeroResponse(type: NonNullable<SerializedResponse["type"]>, url = ""): Response {
  const response = Response.error()
  if (type !== "error") {
    Object.defineProperties(response, {
      type: { value: type, enumerable: true },
      url: { value: type === "opaqueredirect" ? url : "", enumerable: true },
      clone: { value: () => createStatusZeroResponse(type, url) },
    })
  }
  return response
}
