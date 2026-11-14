import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { normalizeBlobOptions } from "../src/config.ts"
import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"
import type { BlobPutOptions } from "../src/types.ts"

afterEach(() => setBlobRuntimeConfig(undefined))

describe("Blob access", () => {
  it("does not let a per-put access option pretend that a served object is private", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-blob-access-"))
    try {
      setBlobRuntimeConfig({ serve: { access: "public", route: "/api/_vitehub/blob", store: "default" }, store: { base, driver: "fs" } })
      // JavaScript callers can still pass the removed option.
      const options = { access: "private", contentType: "text/plain" } as BlobPutOptions
      await expect(blob.put("invoices/1.txt", "secret", options)).rejects.toMatchObject({ code: "BLOB_R0045" })

      // Nothing was written, so the public route has nothing to send.
      const response = await blob.serve(new Request("http://localhost/api/_vitehub/blob/invoices/1.txt"), "invoices/1.txt")
      expect(response.status).toBe(404)
    }
    finally {
      await rm(base, { force: true, recursive: true })
    }
  })

  it("requires an explicit public or authorized serve route", () => {
    expect(() => normalizeBlobOptions({ driver: "fs", serve: true } as never)).toThrow(expect.objectContaining({ code: "BLOB_C0005" }))
    expect(() => normalizeBlobOptions({ driver: "fs", serve: { route: "/files" } } as never)).toThrow(expect.objectContaining({ code: "BLOB_C0021" }))
    expect(() => normalizeBlobOptions({ driver: "fs", serve: { authorize: false, route: "/files" } } as never))
      .toThrow(expect.objectContaining({ code: "BLOB_C0021", message: expect.stringContaining("`blob.serve.authorize: false` does not make the route public. Set `access: \"public\"`") }))
    expect(() => normalizeBlobOptions({ driver: "fs", serve: { public: true } } as never))
      .toThrow(expect.objectContaining({ code: "BLOB_C0021", message: expect.stringContaining("Set `access: \"public\"`") }))
    expect(() => normalizeBlobOptions({ driver: "fs", serve: { access: "private" } } as never))
      .toThrow(expect.objectContaining({ code: "BLOB_C0021", message: expect.stringContaining("Set `authorize: true` to require sign-in.") }))
    expect(() => normalizeBlobOptions({ driver: "fs", serve: { authorize: true, access: "public" } } as never)).toThrow(expect.objectContaining({ code: "BLOB_C0021" }))
    expect(normalizeBlobOptions({ driver: "fs", serve: { access: "public" } })?.serve).toEqual({ access: "public", route: "/api/_vitehub/blob", store: "default" })
    expect(normalizeBlobOptions({ driver: "fs", serve: { authorize: true } })?.serve).toEqual({ authorize: true, route: "/api/_vitehub/blob", store: "default" })
  })
})
