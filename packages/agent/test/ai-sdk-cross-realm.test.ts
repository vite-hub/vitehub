import { runInNewContext } from "node:vm"
import { expect, it } from "vitest"

import { toAiSdkModelMessages } from "../src/ai-sdk.ts"

it("rejects cross-realm Blob attachments in synchronous model conversion", () => {
  const foreignBlob = new Blob(["image"])
  Object.setPrototypeOf(foreignBlob, runInNewContext("Object.prototype"))

  expect(() => toAiSdkModelMessages([{
    id: "message-1",
    parts: [{ data: foreignBlob, mediaType: "image/png", type: "image" }],
    role: "user",
  }])).toThrow("cannot convert a Blob synchronously")
})
