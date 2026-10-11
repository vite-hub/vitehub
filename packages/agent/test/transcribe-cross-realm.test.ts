import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { audioBytes } from "../src/capabilities/transcribe.ts"

describe("Transcribe attachment portability", () => {
  it("reads audio Blobs from another realm", async () => {
    const blob = runInNewContext(`(() => {
      class ForeignBlob {
        size = 3
        type = "audio/ogg"
        arrayBuffer() { return Promise.resolve(new Uint8Array([1, 2, 3]).buffer) }
      }
      Object.defineProperty(ForeignBlob.prototype, Symbol.toStringTag, { value: "Blob" })
      return new ForeignBlob()
    })()`) as Blob

    await expect(audioBytes({ data: blob, mediaType: "audio/ogg", type: "audio" })).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })
})
