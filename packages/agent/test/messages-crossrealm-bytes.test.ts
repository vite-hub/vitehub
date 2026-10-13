import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { isAttachmentData, resolveAttachmentData } from "../src/messages.ts"

describe("Agent attachment byte boundaries", () => {
  it.each(["foreign ArrayBuffer", "foreign Uint8Array"])("accepts %s values", async (kind) => {
    const data = runInNewContext(kind === "foreign ArrayBuffer" ? "new Uint8Array([1, 2, 3]).buffer" : "new Uint8Array([1, 2, 3])") as ArrayBuffer | Uint8Array

    expect(isAttachmentData(data)).toBe(true)
    await expect(resolveAttachmentData({ data, mediaType: "application/octet-stream", type: "file" })).resolves.toBe(data)
  })

  it("uses the intrinsic Uint8Array brand", () => {
    const bytes = new Uint8Array([1, 2, 3])
    Object.defineProperty(bytes, Symbol.toStringTag, { configurable: true, get: () => { throw new Error("tag accessed") } })
    expect(isAttachmentData(bytes)).toBe(true)
    expect(isAttachmentData(new DataView(new ArrayBuffer(3)))).toBe(false)
  })
})
