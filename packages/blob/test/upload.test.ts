import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { BlobMultipartEvent, BlobResult, BlobStorage } from "../src/types.ts"

let base: string
let storage: BlobStorage

function ok<T>(result: BlobResult<T>): T {
  const [error, value] = result
  if (error) throw error
  return value
}

function formRequest(files: File[], field = "files") {
  const form = new FormData()
  for (const file of files) form.append(field, file)
  return { req: new Request("http://localhost/api/files", { body: form, method: "POST" }) }
}

function multipartEvent(action: string, pathname: string, init: RequestInit & { query?: Record<string, string> } = {}): BlobMultipartEvent {
  const url = new URL(`http://localhost/api/files/multipart/${action}/${pathname}`)
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
  return { context: { params: { action, pathname } }, req: new Request(url, init) }
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-blob-upload-"))
  storage = createBlobStorage(createDriver({ base, driver: "fs" }), "default")
})

afterEach(async () => {
  await rm(base, { force: true, recursive: true })
})

describe("handleUpload", () => {
  it("stores each form file under its file name", async () => {
    const objects = ok(await storage.handleUpload(formRequest([
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "../nested/two.txt", { type: "text/plain" }),
    ]), { put: { prefix: "uploads" } }))

    expect(objects.map(object => object.pathname)).toEqual(["uploads/one.txt", "uploads/two.txt"])
    expect(await (ok(await storage.get("uploads/two.txt")))?.text()).toBe("two")
  })

  it("rejects missing, extra, and invalid files with 400 errors", async () => {
    await expect(storage.handleUpload(formRequest([new File(["x"], "x.txt")], "other"))).rejects.toMatchObject({ statusCode: 400 })
    await expect(storage.handleUpload(formRequest([new File(["a"], "a.txt"), new File(["b"], "b.txt")]), { multiple: false }))
      .rejects.toThrow('Form field "files" accepts one file.')
    await expect(storage.handleUpload(formRequest([new File(["x"], "x.txt", { type: "text/plain" })]), { ensure: { types: ["image"] } }))
      .rejects.toThrow("File type is invalid, must be: image")
    await expect(storage.handleUpload({ req: new Request("http://localhost", { body: "plain", method: "POST" }) }))
      .rejects.toThrow("Expected a multipart/form-data request body.")
    expect(ok(await storage.list()).blobs).toEqual([])
  })
})

describe("fs multipart uploads", () => {
  it("joins parts in part-number order and removes the staging files", async () => {
    const upload = ok(await storage.createMultipartUpload("videos/clip.bin", { addRandomSuffix: true }))
    expect(upload.pathname).toMatch(/^videos\/clip-[\da-f]+\.bin$/)

    const resumed = ok(await storage.resumeMultipartUpload(upload.pathname, upload.uploadId))
    const second = ok(await resumed.uploadPart(2, "world"))
    const first = ok(await upload.uploadPart(1, "hello "))
    const object = ok(await resumed.complete([second, first]))

    expect(object).toMatchObject({ contentType: "application/octet-stream", pathname: upload.pathname, size: 11 })
    expect(await (ok(await storage.get(upload.pathname)))?.text()).toBe("hello world")
    expect(await readdir(join(base, ".vitehub", "multipart"))).toEqual([])
  })

  it("rejects unknown uploads, other pathnames, and changed parts", async () => {
    const upload = ok(await storage.createMultipartUpload("a.txt"))
    const part = ok(await upload.uploadPart(1, "a"))

    expect((await storage.resumeMultipartUpload("a.txt", "../../etc"))[0]?.cause).toMatchObject({ message: expect.stringContaining("Unknown multipart upload") })
    expect((await storage.resumeMultipartUpload("b.txt", upload.uploadId))[0]?.cause).toMatchObject({ message: expect.stringContaining("belongs to another pathname") })
    expect((await upload.complete([{ ...part, etag: "\"changed\"" }]))[0]?.cause).toMatchObject({ message: expect.stringContaining("does not match its etag") })
    expect(() => upload.uploadPart(0, "x")).toThrow("`partNumber` must be an integer from 1 to 10000.")

    ok(await upload.abort())
    expect((await storage.resumeMultipartUpload("a.txt", upload.uploadId))[0]?.cause).toMatchObject({ message: expect.stringContaining("Unknown multipart upload") })
  })
})

describe("handleMultipartUpload", () => {
  it("serves create, upload, and complete requests", async () => {
    const created = ok(await storage.handleMultipartUpload(multipartEvent("create", "docs/report.txt", {
      body: JSON.stringify({ contentType: "text/plain" }),
      method: "POST",
    })))
    if (created.action !== "create") throw new TypeError("Expected a create result.")

    const uploaded = ok(await storage.handleMultipartUpload(multipartEvent("upload", created.pathname, {
      body: "report body",
      method: "PUT",
      query: { partNumber: "1", uploadId: created.uploadId },
    })))
    if (uploaded.action !== "upload") throw new TypeError("Expected an upload result.")

    const completed = ok(await storage.handleMultipartUpload(multipartEvent("complete", created.pathname, {
      body: JSON.stringify({ parts: [uploaded.part] }),
      method: "POST",
      query: { uploadId: created.uploadId },
    })))

    expect(completed).toMatchObject({ action: "complete", object: { contentType: "text/plain", pathname: "docs/report.txt" } })
    expect(await (ok(await storage.get("docs/report.txt")))?.text()).toBe("report body")
  })

  it("lets the route fix the content type and aborts uploads", async () => {
    const created = ok(await storage.handleMultipartUpload(multipartEvent("create", "safe.txt", {
      body: JSON.stringify({ contentType: "text/html" }),
      method: "POST",
    }), { create: { contentType: "text/plain" } }))
    if (created.action !== "create") throw new TypeError("Expected a create result.")

    expect(ok(await storage.handleMultipartUpload(multipartEvent("abort", created.pathname, {
      method: "DELETE",
      query: { uploadId: created.uploadId },
    })))).toEqual({ action: "abort" })
    expect(await readdir(join(base, ".vitehub", "multipart"))).toEqual([])
  })

  it("rejects unknown actions, wrong methods, and incomplete requests", async () => {
    await expect(storage.handleMultipartUpload(multipartEvent("rename", "a.txt", { method: "POST" }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(storage.handleMultipartUpload(multipartEvent("toString", "a.txt", { method: "POST" })))
      .rejects.toThrow('Unknown multipart action "toString".')
    await expect(storage.handleMultipartUpload(multipartEvent("create", "a.txt", { method: "GET" }))).rejects.toMatchObject({ statusCode: 405 })
    await expect(storage.handleMultipartUpload(multipartEvent("upload", "a.txt", { body: "x", method: "PUT" })))
      .rejects.toThrow("Missing `uploadId` query parameter.")
    await expect(storage.handleMultipartUpload(multipartEvent("complete", "a.txt", { body: "{}", method: "POST", query: { uploadId: "00000000-0000-4000-8000-000000000000" } })))
      .resolves.toMatchObject([{ code: "BLOB_OPERATION_FAILED" }, undefined])
  })
})
