import { expect, it } from "vitest"

import {
  arrayBufferByteLength,
  createMessage,
  isArrayBufferValue,
  isBlobValue,
  isUint8ArrayValue,
  uint8ArrayByteLength,
} from "../src/messages.ts"

it("captures attachment getters at import before the first message or brand check", () => {
  const blob = new Blob(["hello"])
  const buffer = new ArrayBuffer(3)
  const bytes = new Uint8Array([1, 2, 3])
  // Attachment validation also reads the public byteLength property. Keep those
  // reads stable while replacing the getters used for the intrinsic brand checks.
  Object.defineProperty(buffer, "byteLength", { value: 3 })
  Object.defineProperty(bytes, "byteLength", { value: 3 })
  const getters = [
    { prototype: Blob.prototype, key: "size" },
    { prototype: ArrayBuffer.prototype, key: "byteLength" },
    { prototype: Object.getPrototypeOf(Uint8Array.prototype), key: Symbol.toStringTag },
    { prototype: Object.getPrototypeOf(Uint8Array.prototype), key: "byteLength" },
  ].map(({ prototype, key }) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
    if (!descriptor?.get) throw new Error(`Missing intrinsic getter: ${String(key)}`)
    return { prototype, key, descriptor }
  })
  let replacementReads = 0

  const result = (() => {
    try {
      for (const { prototype, key, descriptor } of getters) {
        Object.defineProperty(prototype, key, {
          ...descriptor,
          get() {
            replacementReads++
            throw new Error("Replacement getter must not be captured")
          },
        })
      }
      return {
        brands: [isBlobValue(blob), isArrayBufferValue(buffer), isUint8ArrayValue(bytes)],
        lengths: [arrayBufferByteLength(buffer), uint8ArrayByteLength(bytes)],
        message: createMessage({
          role: "user",
          parts: [blob, buffer, bytes].map(data => ({ data, mediaType: "application/octet-stream", type: "file" })),
        }),
      }
    }
    finally {
      for (const { prototype, key, descriptor } of getters) {
        Object.defineProperty(prototype, key, descriptor)
      }
    }
  })()

  expect(replacementReads).toBe(0)
  expect(result.brands).toEqual([true, true, true])
  expect(result.lengths).toEqual([3, 3])
  expect(result.message.parts.map(part => "data" in part ? part.data : undefined)).toEqual([blob, buffer, bytes])
})
