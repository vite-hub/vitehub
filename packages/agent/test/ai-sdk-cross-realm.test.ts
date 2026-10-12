import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"

import { createAiSdkAdapter, toAiSdkModelMessages } from "../src/ai-sdk.ts"
import { isAttachmentData, resolveAttachmentData } from "../src/messages.ts"

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
    const adapter = createAiSdkAdapter({
      execution: { attachments: { maxBytes: 5 }, workspaceFallback: false },
      model: {
        specificationVersion: "v3",
        provider: "test",
        modelId: "cross-realm-test",
        supportedUrls: {},
        doGenerate: async (options: { prompt: unknown }) => {
          prompt = options.prompt
          throw reachedModel
        },
        doStream: async () => { throw new Error("Unexpected stream") },
      },
    })
    const context = {
      input: {},
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
    // SAFETY: This context provides the fields used before the model deliberately throws.
    await expect(adapter.generate(context as never)).rejects.toBe(reachedModel)
    expect(prompt).toEqual(expect.arrayContaining([{
      role: "user",
      content: [{ type: "image", image: new TextEncoder().encode("image"), mediaType: "image/png" }],
    }]))

    const limited = createAiSdkAdapter({ model: "test/model", execution: { attachments: { maxBytes: 4 } } })
    // SAFETY: Attachment validation runs before model creation and only reads these context fields.
    await expect(limited.generate(context as never)).rejects.toThrow("exceeds maxBytes (4)")
  })
}
