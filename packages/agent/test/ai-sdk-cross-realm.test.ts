import { runInNewContext } from "node:vm"
import { expect, it, vi } from "vitest"
import { createRuntimeContext } from "@vite-hub/runtime"

import { createAiSdkAdapter, toAiSdkModelMessages } from "../src/ai-sdk.ts"
import { isAttachmentData, resolveAttachmentData } from "../src/messages.ts"
import { portableAgentWorkflowInput } from "../src/index.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import type { AgentAdapterRunContext } from "../src/types.ts"

it("rejects cross-realm Blob attachments in synchronous model conversion", () => {
  const foreignBlob = new Blob(["image"])
  Object.setPrototypeOf(foreignBlob, runInNewContext("Object.prototype"))

  expect(() => toAiSdkModelMessages([{
    id: "message-1",
    parts: [{ data: foreignBlob, mediaType: "image/png", type: "image" }],
    role: "user",
  }])).toThrow("cannot convert a Blob synchronously")
})

it("accepts cross-realm Blob attachments in async resolution", async () => {
  const foreignBlob = new Blob(["image"], { type: "image/png" })
  Object.setPrototypeOf(foreignBlob, runInNewContext("Object.prototype"))
  const direct = { data: foreignBlob, mediaType: "image/png", type: "image" as const }
  const callback = {
    fetchData: () => foreignBlob,
    mediaType: "image/png",
    type: "image" as const,
  }

  expect(isAttachmentData(foreignBlob)).toBe(true)
  await expect(resolveAttachmentData(direct)).resolves.toBe(foreignBlob)
  await expect(resolveAttachmentData(callback)).resolves.toBe(foreignBlob)
})

for (const source of ["direct", "callback"] as const) {
  it(`materializes ${source} cross-realm Blobs and detects their media type`, async () => {
    const foreignBlob = new Blob(["image"], { type: "image/png" })
    Object.setPrototypeOf(foreignBlob, runInNewContext("Object.prototype"))
    const reachedModel = new Error("reached model")
    let prompt: unknown
    const doGenerate = vi.fn(async (options: { prompt: unknown }) => {
      prompt = options.prompt
      throw reachedModel
    })
    const adapter = createAiSdkAdapter({
      execution: { attachments: { maxBytes: 5 }, workspaceFallback: false },
      model: {
        specificationVersion: "v3",
        provider: "test",
        modelId: "cross-realm-test",
        supportedUrls: {},
        doGenerate,
        doStream: async () => { throw new Error("Unexpected stream") },
      },
    })
    const context: AgentAdapterRunContext = {
      actor: { id: "actor" },
      context: createAgentInvocationContextStore(),
      input: {},
      invoker: { id: "invoker", kind: "user" },
      runtime: createRuntimeContext({ runtime: "unknown" }),
      tools: {},
      messages: [{
        id: "message-1",
        role: "user",
        parts: [{
          ...(source === "direct" ? { data: foreignBlob } : { fetchData: () => foreignBlob }),
          mediaType: "application/octet-stream",
          type: "image",
        }],
      }],
    }
    await expect(adapter.generate(context)).rejects.toBe(reachedModel)
    expect(doGenerate).toHaveBeenCalledOnce()
    expect(prompt).toEqual(expect.arrayContaining([expect.objectContaining({
      role: "user",
      content: [expect.objectContaining({ type: "file", data: new TextEncoder().encode("image"), mediaType: "image/png" })],
    })]))

    const limited = createAiSdkAdapter({
      model: {
        specificationVersion: "v3",
        provider: "test",
        modelId: "cross-realm-test",
        supportedUrls: {},
        doGenerate,
        doStream: async () => { throw new Error("Unexpected stream") },
      },
      execution: { attachments: { maxBytes: 4 }, workspaceFallback: false },
    })
    await expect(limited.generate(context)).rejects.toThrow("exceeds maxBytes (4)")
    expect(doGenerate).toHaveBeenCalledOnce()
  })
}

for (const source of ["direct", "callback"] as const) {
  it(`encodes ${source} cross-realm Blobs in durable workflow inputs`, async () => {
    const foreignBlob = new Blob([new Uint8Array([0, 128, 255])], { type: "image/png" })
    Object.setPrototypeOf(foreignBlob, runInNewContext("Object.prototype"))
    const message = {
      id: "message-1",
      role: "user" as const,
      parts: [{
        ...(source === "direct" ? { data: foreignBlob } : { fetchData: () => foreignBlob }),
        mediaType: "image/png",
        type: "image" as const,
      }],
    }
    const portable = await portableAgentWorkflowInput({ messages: [message] })
    expect(portable.messages?.[0]?.parts).toEqual([{
      data: "data:image/png;base64,AID/",
      mediaType: "image/png",
      type: "image",
    }])
  })
}
