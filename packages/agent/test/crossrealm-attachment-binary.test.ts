import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { isArrayBufferValue, isBlobValue, isUint8ArrayValue } from "../src/provider-agent.ts"
import { isAttachmentData, resolveAttachmentData } from "../src/messages.ts"

describe("provider attachment binary values", () => {
  it("recognizes binary values from another realm", () => {
    const foreign = { blob: runInNewContext("new Blob(['x'])"), buffer: runInNewContext("new ArrayBuffer(2)"), bytes: runInNewContext("new Uint8Array([1, 2])") } as Record<string, unknown>
    expect(isBlobValue(foreign.blob)).toBe(true)
    expect(isArrayBufferValue(foreign.buffer)).toBe(true)
    expect(isUint8ArrayValue(foreign.bytes)).toBe(true)
  })

  it("accepts foreign binaries at the attachment resolution boundary", async () => {
    const values = [runInNewContext("new ArrayBuffer(1)"), runInNewContext("new Uint8Array([1])"), runInNewContext("new Blob(['x'])")]
    for (const data of values) {
      expect(isAttachmentData(data)).toBe(true)
      await expect(resolveAttachmentData({ data, mediaType: "application/octet-stream", type: "file" })).resolves.toBe(data)
    }
  })

  it("rejects spoofed binary shapes", () => {
    const spoofed = [
      { get byteLength() { throw new Error("accessed") }, [Symbol.toStringTag]: "ArrayBuffer" },
      { get size() { throw new Error("accessed") }, [Symbol.toStringTag]: "Blob" },
      { get byteLength() { throw new Error("accessed") }, [Symbol.toStringTag]: "Uint8Array" },
    ]
    for (const value of spoofed) {
      expect(isArrayBufferValue(value)).toBe(false)
      expect(isBlobValue(value)).toBe(false)
      expect(isUint8ArrayValue(value)).toBe(false)
      expect(isAttachmentData(value)).toBe(false)
    }
  })
})
