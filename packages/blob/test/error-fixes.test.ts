import { afterAll, beforeEach, expect, it } from "vitest"

import { normalizeBlobOptions } from "../src/config.ts"
import { blobErrorDiagnostics } from "../src/error-diagnostics.ts"
import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"

beforeEach(() => {
  setBlobRuntimeConfig({ store: { base: ".vitehub/data/blob", driver: "fs" } })
})

afterAll(() => {
  setBlobRuntimeConfig(undefined)
})

it("gives each Blob code a fix and its own docs page", () => {
  for (const [code, create] of Object.entries(blobErrorDiagnostics)) {
    const error = create({ message: "message" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/blob/diagnostics/${code.toLowerCase()}`)
  }
})

it("reports an invalid Blob config with a code and a fix", () => {
  expect(() => normalizeBlobOptions({ stores: { media: { driver: "fs" } } })).toThrow(expect.objectContaining({
    code: "BLOB_C0008",
    fix: expect.stringContaining("`default` store"),
    message: "`blob.stores.default` is required when using named Blob stores.",
  }))
})

it("gives an unknown store name the fix of BLOB_R0027", async () => {
  await expect(blob.store("missing").get("note.txt")).rejects.toMatchObject({
    code: "BLOB_R0027",
    fix: blobErrorDiagnostics.BLOB_R0027({ message: "" }).fix,
    message: "Unknown Blob store \"missing\". Configured stores: \"default\".",
  })
})

it("lists the configured store names for an unknown store name", async () => {
  const store = { base: ".vitehub/data/blob", driver: "fs" } as const
  setBlobRuntimeConfig({ store, stores: { default: store, media: store } })

  await expect(blob.store("medai").get("note.txt")).rejects.toMatchObject({
    code: "BLOB_R0027",
    fix: expect.stringContaining("one of the store names that the message lists"),
    why: "Unknown Blob store \"medai\". Configured stores: \"default\", \"media\".",
  })
})
