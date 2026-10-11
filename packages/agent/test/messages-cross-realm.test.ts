import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { isAttachmentData, resolveAttachmentData } from "../src/messages.ts"

describe("Agent attachment boundaries", () => {
  it("accepts a Blob created in another realm", async () => {
    const blob = runInNewContext(`(() => {
      class Blob {
        size = 3
        type = "text/plain"
        arrayBuffer() { return Promise.resolve(new Uint8Array([1, 2, 3]).buffer) }
      }
      Object.defineProperty(Blob.prototype, Symbol.toStringTag, { value: "Blob" })
      return new Blob()
    })()`) as Blob

    expect(isAttachmentData(blob)).toBe(true)
    await expect(resolveAttachmentData({ data: blob, mediaType: "text/plain", type: "file" })).resolves.toBe(blob)
  })
})
