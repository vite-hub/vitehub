import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { H3Event } from "h3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createDriver } from "../src/drivers/fs.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { Result } from "@vite-hub/runtime"

import type { BlobErrorCode, BlobMultipartEvent, BlobStorage } from "../src/types.ts"

let base: string
let storage: BlobStorage

function ok<T>(result: Result<T, BlobErrorCode>): T {
  const [error, value] = result
  if (error) throw error
  return value
}

function formData(files: File[], field = "files"): FormData {
  const form = new FormData()
  for (const file of files) form.append(field, file)
  return form
}

function formRequest(files: File[], field = "files"): H3Event {
  return new H3Event(new Request("http://localhost/api/files", { body: formData(files, field), method: "POST" }))
}

function multipartRequest(action: string, pathname: string, init: RequestInit & { query?: Record<string, string> } = {}): Request {
  const url = new URL(`http://localhost/api/files/multipart/${action}/${pathname}`)
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value)
  return new Request(url, init)
}

function multipartEvent(action: string, pathname: string, init: RequestInit & { query?: Record<string, string> } = {}): BlobMultipartEvent {
  const event = new H3Event(multipartRequest(action, pathname, init))
  event.context.params = { action, pathname }
  return event
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
    await expect(storage.handleUpload(formRequest([new File(["x"], "x.svg", { type: "image/svg+xml" })]), { ensure: { types: ["image"] } }))
      .rejects.toThrow("File type is invalid, must be: image")
    await expect(storage.handleUpload(formRequest([new File(["x"], "x.png", { type: "image/png,text/html" })]), { ensure: { types: ["image"] } }))
      .rejects.toThrow("File type is invalid, must be: image")
    await expect(storage.handleUpload(new H3Event(new Request("http://localhost", { body: "plain", method: "POST" }))))
      .rejects.toThrow("Expected a multipart/form-data request body.")
    expect(ok(await storage.list()).blobs).toEqual([])
  })

  it("serves an uploaded type that a browser opens as a page in a CSP sandbox", async () => {
    for (const type of ["text/html", "image/svg+xml", "multipart/x-mixed-replace; boundary=b", "multipart/mixed; boundary=b", "multipart/byteranges; boundary=b"]) {
      const [object] = ok(await storage.handleUpload(formRequest([new File(["content"], "file", { type })]), { ensure: { maxSize: "1MB" } }))
      const served = await storage.serve(new Request("http://localhost/file"), object!.pathname)
      expect(served.headers.get("content-type"), type).toBe(type)
      expect(served.headers.get("content-security-policy"), type).toBe("sandbox")
      await served.body?.cancel()
    }
  })
})

describe("upload size gates", () => {
  // A body that records whether the handler read it.
  function declaredBody(contentLength: number, contentType: string, init: { method?: string, url?: string } = {}) {
    const state = { read: false }
    const request = new Request(init.url ?? "http://localhost/api/files", {
      body: new ReadableStream({ pull(controller) { state.read = true; controller.close() } }, { highWaterMark: 0 }),
      duplex: "half",
      headers: { "content-length": String(contentLength), "content-type": contentType },
      method: init.method ?? "POST",
    } as RequestInit)
    return { request, state }
  }

  it("rejects a single-file upload above ensure.maxSize with 413 before it reads the body", async () => {
    const { request, state } = declaredBody(2 * 1024 ** 3, "multipart/form-data; boundary=x")

    await expect(storage.handleUpload(new H3Event(request), { ensure: { maxSize: "8MB" }, multiple: false }))
      .rejects.toMatchObject({ statusCode: 413 })
    expect(state.read).toBe(false)
  })

  it("accepts a single file at ensure.maxSize with its multipart framing", async () => {
    const objects = ok(await storage.handleUpload(formRequest([new File(["x".repeat(1024)], "a.txt", { type: "text/plain" })]), {
      ensure: { maxSize: "1KB" },
      multiple: false,
    }))
    expect(objects.map(object => object.size)).toEqual([1024])
  })

  it("keeps reading requests without Content-Length", async () => {
    const request = new Request("http://localhost/api/files", { body: formData([new File(["x".repeat(2048)], "a.txt")]), method: "POST" })
    request.headers.delete("content-length")
    await expect(storage.handleUpload(new H3Event(request), { ensure: { maxSize: "1KB" }, multiple: false }))
      .rejects.toThrow("File size must be less than 1KB")
  })

  it("checks multipart create against ensure.types and the declared size", async () => {
    const create = (body: Record<string, unknown>) => storage.handleMultipartUpload(
      multipartEvent("create", "clip.bin", { body: JSON.stringify(body), method: "POST" }),
      { ensure: { maxSize: "1KB", types: ["video"] } },
    )

    await expect(create({ contentType: "text/html" })).rejects.toThrow("File type is invalid, must be: video")
    await expect(create({})).rejects.toThrow("File type is invalid, must be: video")
    await expect(create({ contentType: "video/mp4", size: 2048 })).rejects.toThrow("File size must be less than 1KB")
    expect(ok(await create({ contentType: "video/mp4", size: 1024 }))).toMatchObject({ action: "create" })
  })

  it("checks the route content type, not the client one, against ensure.types", async () => {
    const created = ok(await storage.handleMultipartUpload(
      multipartEvent("create", "clip.bin", { body: JSON.stringify({ contentType: "text/html" }), method: "POST" }),
      { create: { contentType: "video/mp4" }, ensure: { types: ["video"] } },
    ))
    expect(created).toMatchObject({ action: "create" })
  })

  it("rejects a multipart part above ensure.maxSize with 413 before it reads the body", async () => {
    const created = ok(await storage.handleMultipartUpload(multipartEvent("create", "clip.bin", { body: "{}", method: "POST" })))
    if (created.action !== "create") throw new TypeError("Expected a create result.")
    const { request, state } = declaredBody(2 * 1024 ** 3, "application/octet-stream", {
      method: "PUT",
      url: `http://localhost/api/files/multipart/upload/clip.bin?partNumber=1&uploadId=${created.uploadId}`,
    })
    const event = new H3Event(request)
    event.context.params = { action: "upload", pathname: "clip.bin" }

    await expect(storage.handleMultipartUpload(event, { ensure: { maxSize: "1KB" } })).rejects.toMatchObject({ statusCode: 413 })
    expect(state.read).toBe(false)
  })

  it("deletes a completed multipart object above ensure.maxSize", async () => {
    const options = { ensure: { maxSize: "1KB" as const } }
    const created = ok(await storage.handleMultipartUpload(multipartEvent("create", "clip.bin", { body: "{}", method: "POST" }), options))
    if (created.action !== "create") throw new TypeError("Expected a create result.")
    const parts = []
    for (const partNumber of [1, 2]) {
      const uploaded = ok(await storage.handleMultipartUpload(multipartEvent("upload", "clip.bin", {
        body: "x".repeat(1000),
        method: "PUT",
        query: { partNumber: String(partNumber), uploadId: created.uploadId },
      }), options))
      if (uploaded.action !== "upload") throw new TypeError("Expected an upload result.")
      parts.push(uploaded.part)
    }

    await expect(storage.handleMultipartUpload(multipartEvent("complete", "clip.bin", {
      body: JSON.stringify({ parts }),
      method: "POST",
      query: { uploadId: created.uploadId },
    }), options)).rejects.toThrow("File size must be less than 1KB")
    expect(ok(await storage.head("clip.bin"))).toBeNull()
  })
})

describe("uploads from host Standard Context events", () => {
  const hostEvent = (req: Request, params?: Record<string, string>) => ({
    "~standard": { vendor: "test", req, res: {} },
    context: { params },
  })

  it("stores files from the Standard Context request", async () => {
    const event = hostEvent(new Request("http://localhost/api/files", { body: formData([new File(["one"], "one.txt", { type: "text/plain" })]), method: "POST" }))

    const objects = ok(await storage.handleUpload(event))

    expect(objects.map(object => object.pathname)).toEqual(["one.txt"])
    expect(await (ok(await storage.get("one.txt")))?.text()).toBe("one")
  })

  it("serves multipart actions from the Standard Context request", async () => {
    const event = (action: string, init: RequestInit & { query?: Record<string, string> }) =>
      hostEvent(multipartRequest(action, "videos/clip.bin", init), { action, pathname: "videos/clip.bin" })
    const created = ok(await storage.handleMultipartUpload(event("create", { body: JSON.stringify({ contentType: "video/mp4" }), method: "POST" })))
    if (created.action !== "create") throw new Error("Expected a create result.")
    const uploaded = ok(await storage.handleMultipartUpload(event("upload", { body: "part", method: "PUT", query: { partNumber: "1", uploadId: created.uploadId } })))
    if (uploaded.action !== "upload") throw new Error("Expected an upload result.")
    const completed = ok(await storage.handleMultipartUpload(event("complete", { body: JSON.stringify({ parts: [uploaded.part] }), method: "POST", query: { uploadId: created.uploadId } })))

    expect(completed).toMatchObject({ action: "complete", object: { pathname: "videos/clip.bin" } })
    expect(await (ok(await storage.get("videos/clip.bin")))?.text()).toBe("part")
    await expect(storage.handleMultipartUpload(event("upload", { body: "part", method: "POST", query: { partNumber: "1", uploadId: created.uploadId } })))
      .rejects.toMatchObject({ statusCode: 405 })
  })
})

describe("uploads from a Request and a nuxt/server event", () => {
  // The shape of a `nuxt/server` RequestEvent: no `~standard` until ViteHub reads it.
  const nuxtServerEvent = (req: Request, params?: Record<string, string>) => ({
    context: { params },
    req,
    res: { headers: new Headers() },
    url: new URL(req.url),
  })

  it("stores files from a plain Request", async () => {
    const request = new Request("http://localhost/api/files", { body: formData([new File(["one"], "one.txt")]), method: "POST" })
    expect(ok(await storage.handleUpload(request)).map(object => object.pathname)).toEqual(["one.txt"])
  })

  it("stores files from a nuxt/server event", async () => {
    const event = nuxtServerEvent(new Request("http://localhost/api/files", { body: formData([new File(["one"], "one.txt")]), method: "POST" }))
    expect(ok(await storage.handleUpload(event)).map(object => object.pathname)).toEqual(["one.txt"])
  })

  it("serves multipart actions from a nuxt/server event", async () => {
    const event = (action: string, init: RequestInit & { query?: Record<string, string> }) =>
      nuxtServerEvent(multipartRequest(action, "clip.bin", init), { action, pathname: "clip.bin" })
    const created = ok(await storage.handleMultipartUpload(event("create", { body: "{}", method: "POST" })))
    if (created.action !== "create") throw new Error("Expected a create result.")
    const uploaded = ok(await storage.handleMultipartUpload(event("upload", { body: "part", method: "PUT", query: { partNumber: "1", uploadId: created.uploadId } })))
    if (uploaded.action !== "upload") throw new Error("Expected an upload result.")
    ok(await storage.handleMultipartUpload(event("complete", { body: JSON.stringify({ parts: [uploaded.part] }), method: "POST", query: { uploadId: created.uploadId } })))

    expect(await (ok(await storage.get("clip.bin")))?.text()).toBe("part")
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

  it.each([
    { label: "duplicate", parts: (part: { etag: string, partNumber: number }) => [part, part] },
    { label: "zero", parts: (part: { etag: string }) => [{ ...part, partNumber: 0 }] },
    { label: "too large", parts: (part: { etag: string }) => [{ ...part, partNumber: 10_001 }] },
  ])("rejects $label complete parts", async ({ parts }) => {
    const created = ok(await storage.handleMultipartUpload(multipartEvent("create", "invalid-parts.txt", {
      method: "POST",
    })))
    if (created.action !== "create") throw new TypeError("Expected a create result.")
    const uploaded = ok(await storage.handleMultipartUpload(multipartEvent("upload", created.pathname, {
      body: "part",
      method: "PUT",
      query: { partNumber: "1", uploadId: created.uploadId },
    })))
    if (uploaded.action !== "upload") throw new TypeError("Expected an upload result.")

    await expect(storage.handleMultipartUpload(multipartEvent("complete", created.pathname, {
      body: JSON.stringify({ parts: parts(uploaded.part) }),
      method: "POST",
      query: { uploadId: created.uploadId },
    }))).rejects.toMatchObject({ statusCode: 400 })
  })
})
