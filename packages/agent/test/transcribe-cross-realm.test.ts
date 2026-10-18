import { runInNewContext } from "node:vm"
import { Worker } from "node:worker_threads"

import { describe, expect, it } from "vitest"

import { audioBytes } from "../src/capabilities/transcribe.ts"

describe("Transcribe attachment portability", () => {
  it("reads native Blobs constructed in a VM context", async () => {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const worker = new Worker(`const { parentPort } = require("node:worker_threads"); const { Blob } = require("node:buffer"); parentPort.postMessage(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }))`, { eval: true })
      worker.once("message", (value: Blob) => { resolve(value); void worker.terminate() })
      worker.once("error", reject)
    })

    await expect(audioBytes({ data: blob, mediaType: "audio/ogg", type: "audio" })).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it("rejects spoofed Blob tags", async () => {
    const blob = { size: 3, arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) }
    Object.defineProperty(blob, Symbol.toStringTag, { value: "Blob" })

    await expect(audioBytes({ data: blob as Blob, mediaType: "audio/ogg", type: "audio" })).rejects.toMatchObject({ code: "AGENT_R0239" })
  })
  it("reads a native Blob with a foreign prototype", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    Object.setPrototypeOf(blob, runInNewContext("({})"))
    expect(blob instanceof Blob).toBe(false)
    await expect(audioBytes({ data: blob, mediaType: "audio/ogg", type: "audio" })).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it("uses native Blob size and bytes despite overridden properties", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    Object.defineProperty(blob, "size", { value: 0 })
    Object.defineProperty(blob, "arrayBuffer", { value: () => Promise.resolve(new ArrayBuffer(100)) })
    await expect(audioBytes({ data: blob, mediaType: "audio/ogg", type: "audio" }, { maxBytes: 3 })).resolves.toEqual(new Uint8Array([1, 2, 3]))
    await expect(audioBytes({ data: blob, mediaType: "audio/ogg", type: "audio" }, { maxBytes: 2 })).rejects.toThrow("exceeds maxBytes")
  })

  it.each(["new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)", "new Uint8Array([1, 2, 3]).buffer"])("reads cross-realm binary data: %s", async (expression) => {
    const data = runInNewContext(expression) as Uint8Array | ArrayBuffer
    await expect(audioBytes({ data, mediaType: "audio/ogg", type: "audio" }, { maxBytes: 3 })).resolves.toEqual(new Uint8Array([1, 2, 3]))
    await expect(audioBytes({ fetchData: () => data, mediaType: "audio/ogg", type: "audio" }, { maxBytes: 2 })).rejects.toThrow("exceeds maxBytes")
  })

  it("uses the intrinsic ArrayBuffer size for maxBytes", async () => {
    const data = new ArrayBuffer(100)
    Object.defineProperty(data, "byteLength", { value: 0 })
    await expect(audioBytes({ data, mediaType: "audio/ogg", type: "audio" }, { maxBytes: 1 })).rejects.toThrow("exceeds maxBytes")
    await expect(audioBytes({ fetchData: () => data, mediaType: "audio/ogg", type: "audio" }, { maxBytes: 1 })).rejects.toThrow("exceeds maxBytes")
  })

  it("preserves a spoofed Uint16Array's raw byte range", async () => {
    const data = new Uint16Array([0x1234, 0x5678, 0x9abc]).subarray(1, 2)
    Object.defineProperty(data, Symbol.toStringTag, { value: "Uint8Array" })
    await expect(audioBytes({ data: data as unknown as Uint8Array, mediaType: "audio/ogg", type: "audio" })).resolves.toEqual(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  })

  it("uses the intrinsic Uint8Array size for maxBytes", async () => {
    const data = new Uint8Array([1, 2, 3])
    Object.defineProperty(data, "byteLength", { value: 0 })
    await expect(audioBytes({ data, mediaType: "audio/ogg", type: "audio" }, { maxBytes: 2 })).rejects.toThrow("exceeds maxBytes")
  })

})
