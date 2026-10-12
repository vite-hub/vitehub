import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { audioBytes } from "../src/capabilities/transcribe.ts"
import { toAiSdkModelMessages } from "../src/ai-sdk.ts"
import { portableAgentWorkflowInput } from "../src/index.ts"

import { isAttachmentData, resolveAttachmentData } from "../src/messages.ts"

describe("Agent attachment boundaries", () => {
  it.each([
    new Blob([new Uint8Array([1, 2, 3])]),
    new File([new Uint8Array([1, 2, 3])], "audio.wav"),
  ])("preserves native Blob and File support", async (data) => {
    expect(isAttachmentData(data)).toBe(true)
    await expect(audioBytes({ data, mediaType: "audio/wav", type: "audio" })).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

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

    expect(blob).not.toBeInstanceOf(Blob)
    expect(isAttachmentData(blob)).toBe(true)
    await expect(resolveAttachmentData({ data: blob, mediaType: "text/plain", type: "file" })).resolves.toBe(blob)
    await expect(audioBytes({ data: blob, mediaType: "audio/wav", type: "audio" })).resolves.toEqual(new Uint8Array([1, 2, 3]))
    await expect(audioBytes({ fetchData: () => blob, mediaType: "audio/wav", type: "audio" }, { maxBytes: 2 })).rejects.toThrow("exceeds maxBytes")
    const message = { id: "foreign-blob", role: "user" as const, parts: [{ data: blob, mediaType: "text/plain", type: "file" as const }] }
    expect(() => toAiSdkModelMessages([message])).toThrow("cannot convert a Blob synchronously")
    const portable = await portableAgentWorkflowInput({ messages: [message] })
    expect(portable.messages?.[0]?.parts[0]).toEqual({ data: "data:text/plain;base64,AQID", mediaType: "text/plain", type: "file" })
  })

  it("enforces byte limits after materializing a spoofed Blob", async () => {
    const blob = {
      size: 1,
      type: "audio/wav",
      arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer),
      [Symbol.toStringTag]: "Blob",
    } as unknown as Blob

    expect(isAttachmentData(blob)).toBe(true)
    await expect(audioBytes({ data: blob, mediaType: "audio/wav", type: "audio" }, { maxBytes: 2 })).rejects.toThrow("exceeds maxBytes")
  })
})
