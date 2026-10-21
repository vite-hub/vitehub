import { HTTPError } from "h3"

const maxRequestStateBytes = 8 * 1024 * 1024

const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!
const typedArrayLengthGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")!.get!
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer")!.get!
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteOffset")!.get!

function normalizeRealtimeStateChunk(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) {
    try {
      // Walk the full prototype chain and keep the intrinsic width. Subclass
      // prototypes may shadow BYTES_PER_ELEMENT, while the concrete typed-array
      // prototype later in the chain carries the actual element width.
      let prototype = Object.getPrototypeOf(value)
      let bytesPerElement: unknown
      while (prototype) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "BYTES_PER_ELEMENT")
        if (descriptor && "value" in descriptor) {
          bytesPerElement = descriptor.value
        }
        prototype = Object.getPrototypeOf(prototype)
      }
      if (bytesPerElement !== 1) return undefined
      // SAFETY: The intrinsic TypedArray byteLength getter returns a number and throws for incompatible receivers.
      const byteLength = Reflect.apply(typedArrayByteLengthGetter, value, []) as number
      // SAFETY: The intrinsic TypedArray length getter returns a number and throws for incompatible receivers.
      const length = Reflect.apply(typedArrayLengthGetter, value, []) as number
      if (byteLength !== length) return undefined
      // SAFETY: Intrinsic TypedArray getters return the branded view's backing buffer and byte offset.
      const buffer = Reflect.apply(typedArrayBufferGetter, value, []) as ArrayBufferLike
      // SAFETY: The intrinsic TypedArray byteOffset getter returns a number for this branded view.
      const byteOffset = Reflect.apply(typedArrayByteOffsetGetter, value, []) as number
      return new Uint8Array(buffer, byteOffset, byteLength)
    }
    catch {
      return undefined
    }
  }

  try {
    Reflect.apply(arrayBufferByteLengthGetter, value, [])
    // SAFETY: The intrinsic ArrayBuffer byteLength getter above rejects values without the ArrayBuffer internal slots.
    return new Uint8Array(value as ArrayBuffer)
  }
  catch {
    return undefined
  }
}

export async function readRealtimeRequestState(request: Request, maxBytes = maxRequestStateBytes): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") || 0)
  if (contentLength > maxBytes) throw new HTTPError({ status: 413, message: "Realtime request state exceeds 8 MiB." })
  if (!request.body) return new Uint8Array()

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = normalizeRealtimeStateChunk(value)
      if (!chunk) {
        await reader.cancel()
        throw new HTTPError({ status: 400, message: "Realtime request body contains invalid bytes." })
      }
      byteLength += chunk.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw new HTTPError({ status: 413, message: "Realtime request state exceeds 8 MiB." })
      }
      chunks.push(chunk)
    }
  }
  finally {
    reader.releaseLock()
  }

  const state = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    state.set(chunk, offset)
    offset += chunk.byteLength
  }
  return state
}
