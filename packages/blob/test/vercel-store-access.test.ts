import { afterEach, describe, expect, it, vi } from "vitest"

import { blobDocument } from "../../realtime/src/blob-document.ts"
import { normalizeBlobOptions } from "../src/config.ts"
import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"

import type { BlobOptions } from "../src/types.ts"

const vercel = vi.hoisted(() => ({
  head: vi.fn(),
  put: vi.fn(async (pathname: string, _body: unknown, _options: { access?: string }) => ({ contentType: "text/plain", pathname, url: `https://store.blob.vercel-storage.com/${pathname}` })),
}))

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>()
  return { ...actual, head: vercel.head, put: vercel.put }
})

const env = { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test" }

afterEach(() => {
  setBlobRuntimeConfig(undefined)
  vi.unstubAllEnvs()
  vercel.put.mockClear()
})

/** Writes through the runtime `blob` export and returns the `access` that `@vercel/blob` received. */
async function accessSent(options: BlobOptions): Promise<unknown> {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", env.BLOB_READ_WRITE_TOKEN)
  setBlobRuntimeConfig(normalizeBlobOptions(options, { env }))
  const [error] = await blob.put("drafts/a.md", "# Draft", { contentType: "text/markdown" })
  expect(error).toBeUndefined()
  return vercel.put.mock.lastCall?.[2]?.access
}

describe("Vercel Blob store access", () => {
  it("writes private objects when the serve route requires authorization", async () => {
    expect(await accessSent({ driver: "vercel-blob", serve: { authorize: true } })).toBe("private")
  })

  it("writes private objects when no route serves the store", async () => {
    expect(await accessSent({ driver: "vercel-blob" })).toBe("private")
    expect(await accessSent({ stores: { default: { driver: "fs" }, drafts: { driver: "vercel-blob" } }, serve: { access: "public" } })).toBe("private")
  })

  it("writes public objects only when the store or its route says public", async () => {
    expect(await accessSent({ driver: "vercel-blob", serve: { access: "public" } })).toBe("public")
    expect(await accessSent({ access: "public", driver: "vercel-blob" })).toBe("public")
    expect(await accessSent({ access: "public", driver: "vercel-blob", serve: { access: "public" } })).toBe("public")
    expect(await accessSent({ access: "private", driver: "vercel-blob", serve: { access: "public" } })).toBe("private")
  })

  it("rejects a public provider store behind an authorized route", () => {
    expect(() => normalizeBlobOptions({ access: "public", driver: "vercel-blob", serve: { authorize: true } }, { env }))
      .toThrow(expect.objectContaining({ code: "BLOB_C0022" }))
    expect(() => normalizeBlobOptions({ serve: { authorize: true, store: "files" }, stores: { default: { driver: "fs" }, files: { access: "public", driver: "vercel-blob" } } }, { env }))
      .toThrow(expect.objectContaining({ code: "BLOB_C0022" }))
  })

  it("saves a Realtime blobDocument draft as a private object", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", env.BLOB_READ_WRITE_TOKEN)
    setBlobRuntimeConfig(normalizeBlobOptions({ driver: "vercel-blob", serve: { authorize: true } }, { env }))
    vercel.head.mockRejectedValue(new (await import("@vercel/blob")).BlobNotFoundError())
    const adapter = blobDocument(blob, { prefix: "drafts/" })

    await adapter.save({ authority: "memory", definition: "drafts", documentId: "a.md" }, { body: "# Draft" }, { editors: [], ifDigest: null, reason: "idle" })
    expect(vercel.put).toHaveBeenCalledWith("drafts/a.md", "# Draft", expect.objectContaining({ access: "private" }))
  })
})
