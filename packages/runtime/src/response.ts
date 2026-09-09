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
  return new Response(bytes, {
    headers: value.headers,
    status: value.status,
    statusText: value.statusText,
  })
}

export function isSerializedResponse(value: unknown): value is SerializedResponse {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  if (!record.body || typeof record.body !== "object") return false
  const body = record.body as Record<string, unknown>
  if (typeof body.data !== "string" || body.encoding !== "base64" || typeof body.mediaType !== "string") return false
  if (!Number.isInteger(record.status) || (record.status as number) < 200 || (record.status as number) > 599) return false
  if (typeof record.statusText !== "string" || !Array.isArray(record.headers)) return false
  return record.headers.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string")
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
