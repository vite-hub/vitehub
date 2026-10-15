import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { isArrayBufferValue, isBlobValue, isUint8ArrayValue } from "../src/provider-agent.ts"
import { createMessage, portableAgentWorkflowInput } from "../src/index.ts"
import { isAttachmentData, resolveAttachmentData } from "../src/messages.ts"

describe("provider attachment binary values", () => {
  it("recognizes binary values from another realm", () => {
    const foreign = { blob: runInNewContext("new Blob(['x'])", { Blob }), buffer: runInNewContext("new ArrayBuffer(2)"), bytes: runInNewContext("new Uint8Array([1, 2])") } as Record<string, unknown>
    expect(isBlobValue(foreign.blob)).toBe(true)
    expect(isArrayBufferValue(foreign.buffer)).toBe(true)
    expect(isUint8ArrayValue(foreign.bytes)).toBe(true)
  })

  it("accepts foreign binaries at the attachment resolution boundary", async () => {
    const values = [runInNewContext("new ArrayBuffer(1)"), runInNewContext("new Uint8Array([1])"), runInNewContext("new Blob(['x'])", { Blob })]
    for (const data of values) {
      expect(isAttachmentData(data)).toBe(true)
      await expect(resolveAttachmentData({ data, mediaType: "application/octet-stream", type: "file" })).resolves.toBe(data)
    }
  })

  it("preserves empty direct and fetched Blob attachments across realms", async () => {
    const foreign = new Blob([])
    Object.setPrototypeOf(foreign, runInNewContext("Object.create(null, descriptors)", {
      descriptors: Object.getOwnPropertyDescriptors(Blob.prototype),
    }))
    expect(foreign instanceof Blob).toBe(false)
    for (const data of [new Blob([]), foreign]) {
      expect(isAttachmentData(data)).toBe(true)
      for (const source of [{ data }, { fetchData: () => data }]) {
        await expect(resolveAttachmentData({ ...source, mediaType: "application/octet-stream", type: "file" })).resolves.toBe(data)
      }
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

describe("workflow attachment portability", () => {
  it("serializes direct and fetched foreign binaries in every message input form", async () => {
    const values: unknown[] = [
      runInNewContext("new Uint8Array([1, 2]).buffer"),
      runInNewContext("new Uint8Array([0, 1, 2, 0]).subarray(1, 3)"),
    ]
    const blob = new Blob([new Uint8Array([1, 2])])
    // Preserve native Blob slots and methods with a separate realm's prototype.
    Object.setPrototypeOf(blob, runInNewContext("Object.create(null, descriptors)", {
      descriptors: Object.getOwnPropertyDescriptors(Blob.prototype),
    }))
    expect(blob instanceof Blob).toBe(false)
    values.push(blob)
    for (const data of values) {
      if (!isAttachmentData(data)) throw new Error("Invalid binary fixture")
      for (const attachment of [{ data }, { fetchData: () => data }]) {
        const message = createMessage({
          parts: [{ ...attachment, mediaType: "application/octet-stream", type: "file" }],
          role: "user",
        })
        const portable = await portableAgentWorkflowInput({ message, messages: [message], prompt: [message] })
        const expected = { parts: [{ data: "data:application/octet-stream;base64,AQI=", mediaType: "application/octet-stream", type: "file" }] }
        expect(portable.message).toMatchObject(expected)
        expect(portable.messages).toMatchObject([expected])
        expect(portable.prompt).toMatchObject([expected])
        expect(JSON.stringify(portable)).not.toContain("fetchData")
      }
    }
  })
})
