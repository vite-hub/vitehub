import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"
import type { BlobStoreOptions, BlobSignOptions } from "../src/types.ts"

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-blob-read-mode-"))
  const store = { base, driver: "fs" as const }
  setBlobRuntimeConfig({ store, stores: { default: store, reports: store } })
})

afterEach(async () => {
  setBlobRuntimeConfig(undefined)
  await rm(base, { force: true, recursive: true })
})

describe("blob.store(name, { mode: \"read\" })", () => {
  it("reads objects of the selected store", async () => {
    const [writeError] = await blob.store("reports").put("q1.txt", "revenue")
    expect(writeError).toBeNull()

    const reader = blob.store("reports", { mode: "read" })
    const [getError, object] = await reader.get("q1.txt")
    expect(getError).toBeNull()
    expect(await object?.text()).toBe("revenue")
    expect((await reader.head("q1.txt"))[1]).toMatchObject({ pathname: "q1.txt", size: 7 })
    expect((await reader.list())[1]?.blobs.map(item => item.pathname)).toEqual(["q1.txt"])
    expect((await reader.media.get("q1.txt"))[1]).toMatchObject({ pathname: "q1.txt" })
  })

  it("has no write methods at runtime", () => {
    const reader = blob.store("default", { mode: "read" })
    for (const method of ["put", "del", "handleUpload", "handleMultipartUpload", "createMultipartUpload", "resumeMultipartUpload", "store"]) {
      expect(method in reader).toBe(false)
    }
    for (const method of ["put", "remove", "move", "moveFolder", "createFolder", "removeFolder", "replaceCrop", "update", "handleUpload"]) {
      expect(method in reader.media).toBe(false)
    }
    expect(Object.keys(reader).sort()).toEqual(["get", "head", "list", "media", "serve", "sign"])
    expect(Object.keys(reader.media).sort()).toEqual(["get", "list", "variants"])
  })

  it("rejects a signed PUT request", async () => {
    const reader = blob.store("default", { mode: "read" })
    // SAFETY: A JavaScript caller can pass a PUT request that the type rejects.
    const options = { expiresIn: 60, method: "PUT" } as BlobSignOptions as { expiresIn: number, method: "GET" }
    await expect(reader.sign("q1.txt", options)).rejects.toMatchObject({ code: "BLOB_R0037" })
  })

  it("rejects an unknown mode instead of returning a writable handle", () => {
    // SAFETY: A JavaScript caller can pass a mode that the type rejects.
    const options = { mode: "readonly" } as unknown as BlobStoreOptions
    expect(() => blob.store("default", options)).toThrow(expect.objectContaining({ code: "BLOB_R0038" }))
  })

  it("keeps the writable handle by default", () => {
    expect(typeof blob.store("default").put).toBe("function")
    expect(typeof blob.store("default", { mode: "write" }).del).toBe("function")
  })
})
