import { runInNewContext } from "node:vm"

import { afterEach, describe, expect, it, vi } from "vitest"

import { audioBytes } from "../src/capabilities/transcribe.ts"
import { toAiSdkModelMessages } from "../src/ai-sdk.ts"
import { portableAgentWorkflowInput } from "../src/index.ts"

import { isAttachmentData, resolveAttachmentData } from "../src/messages.ts"

describe("Agent attachment boundaries", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    new Blob([new Uint8Array([1, 2, 3])]),
    new File([new Uint8Array([1, 2, 3])], "audio.wav"),
  ])("preserves native Blob and File support", async (data) => {
    expect(isAttachmentData(data)).toBe(true)
    await expect(audioBytes({ data, mediaType: "audio/wav", type: "audio" })).resolves.toEqual(new Uint8Array([1, 2, 3]))
  })

  it("accepts a Blob created in another realm", async () => {
    const NativeBlob = Blob
    const blob: Blob = runInNewContext(`(() => {
      class ForeignBlob extends NativeBlob {}
      return new ForeignBlob([new Uint8Array([1, 2, 3])], { type: "text/plain" })
    })()`, { NativeBlob })
    class LocalBlob extends NativeBlob {}
    Object.defineProperties(LocalBlob.prototype, Object.getOwnPropertyDescriptors(NativeBlob.prototype))
    vi.stubGlobal("Blob", LocalBlob)
    expect(blob).toBeInstanceOf(NativeBlob)

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

  it("rejects a spoofed Blob without materializing its data", async () => {
    const blob = {
      size: 1,
      type: "audio/wav",
      arrayBuffer: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]).buffer)),
      [Symbol.toStringTag]: "Blob",
    }

    expect(isAttachmentData(blob)).toBe(false)
    // SAFETY: Intentionally invalid Blob data probes rejection at the runtime attachment boundary.
    await expect(resolveAttachmentData({ fetchData: () => blob as unknown as Blob, mediaType: "audio/wav", type: "audio" })).resolves.toBeUndefined()
    expect(blob.arrayBuffer).not.toHaveBeenCalled()
  })
})
