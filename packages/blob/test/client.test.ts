import { describe, expect, it, vi } from "vitest"

import { createMultipartUploader, uploadFiles } from "../src/client.ts"
import { useMultipartUpload, useUpload } from "../src/vue.ts"

type FetchInput = Parameters<typeof fetch>[0]

const object = { contentType: "text/plain", customMetadata: {}, httpEtag: "\"e\"", httpMetadata: {}, pathname: "a.txt", size: 1, uploadedAt: "2026-01-01T00:00:00.000Z" }

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
}

// A fake multipart route that records each request.
function multipartServer() {
  const requests: Array<{ body?: RequestInit["body"], headers: Headers, method?: string, url: string }> = []
  const fetch = vi.fn(async (url: FetchInput, init: RequestInit = {}) => {
    const href = String(url)
    requests.push({ body: init.body, headers: new Headers(init.headers), method: init.method, url: href })
    if (href.includes("/create/")) return json({ action: "create", pathname: "big file.bin", uploadId: "u1" })
    if (href.includes("/upload/")) {
      const partNumber = Number(new URL(href, "http://x").searchParams.get("partNumber"))
      return json({ action: "upload", part: { etag: `"p${partNumber}"`, partNumber } })
    }
    if (href.includes("/complete/")) return json({ action: "complete", object: { ...object, pathname: "big file.bin" } })
    return json({ action: "abort" })
  })
  return { fetch, requests }
}

describe("uploadFiles", () => {
  it("posts every file in one form field", async () => {
    const fetch = vi.fn(async (_url: FetchInput, _init?: RequestInit) => json([object, object]))
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")]

    await expect(uploadFiles("/api/files", files, { fetch, formKey: "attachments", headers: { authorization: "Bearer t" } })).resolves.toEqual([object, object])

    const [url, init = {}] = fetch.mock.calls[0]!
    expect(url).toBe("/api/files")
    expect(init.method).toBe("POST")
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t")
    expect(init.body).toBeInstanceOf(FormData)
    // SAFETY: The assertion above narrows the request body to FormData.
    expect((init.body as FormData).getAll("attachments")).toHaveLength(2)
  })

  it("accepts an input element and reports server errors", async () => {
    const fetch = vi.fn(async () => new Response("File type is invalid", { status: 400 }))

    await expect(uploadFiles("/api/files", { files: [new File(["a"], "a.txt")] }, { fetch })).rejects.toThrow("Upload request failed with status 400: File type is invalid")
    await expect(uploadFiles("/api/files", [], { fetch })).resolves.toEqual([])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, {}, [object, undefined], Array.from({ length: 1 })])("rejects malformed successful responses", async responseBody => {
    const fetch = vi.fn(async () => json(responseBody))

    await expect(uploadFiles("/api/files", [new File(["a"], "a.txt")], { fetch })).rejects.toThrow("Upload request returned malformed JSON.")
  })
})

describe("createMultipartUploader", () => {
  it("creates the upload, sends each part, and completes with every part", async () => {
    const { fetch, requests } = multipartServer()
    const progress: number[] = []
    const upload = createMultipartUploader("/api/files/multipart/", { fetch, onProgress: value => progress.push(value), partSize: 4 })

    const result = await upload(new File(["0123456789"], "big file.bin", { type: "application/octet-stream" })).completed

    expect(result).toMatchObject({ pathname: "big file.bin" })
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      "POST /api/files/multipart/create/big%20file.bin",
      "PUT /api/files/multipart/upload/big%20file.bin?partNumber=1&uploadId=u1",
      "PUT /api/files/multipart/upload/big%20file.bin?partNumber=2&uploadId=u1",
      "PUT /api/files/multipart/upload/big%20file.bin?partNumber=3&uploadId=u1",
      "POST /api/files/multipart/complete/big%20file.bin?uploadId=u1",
    ])
    expect(JSON.parse(String(requests[0]!.body))).toEqual({ contentType: "application/octet-stream" })
    expect(JSON.parse(String(requests.at(-1)!.body)).parts).toEqual([
      { etag: "\"p1\"", partNumber: 1 },
      { etag: "\"p2\"", partNumber: 2 },
      { etag: "\"p3\"", partNumber: 3 },
    ])
    expect(progress).toEqual([0, 33, 67, 100])
  })

  it("aborts the server upload and resolves with undefined", async () => {
    const { fetch, requests } = multipartServer()
    let releasePart: () => void = () => {}
    fetch.mockImplementationOnce(async () => json({ action: "create", pathname: "a.bin", uploadId: "u2" }))
    fetch.mockImplementationOnce(async (_url, init) => {
      await new Promise<void>((resolve) => { releasePart = resolve })
      init?.signal?.throwIfAborted()
      return json({ action: "upload", part: { etag: "\"p1\"", partNumber: 1 } })
    })
    const task = createMultipartUploader("/api/multipart", { fetch, partSize: 1 })(new File(["ab"], "a.bin"))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

    await task.abort()
    releasePart()

    await expect(task.completed).resolves.toBeUndefined()
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: "/api/multipart/abort/a.bin?uploadId=u2" })
  })

  it.each([
    { pathname: "a.bin" },
    { pathname: "a.bin", uploadId: 42 },
  ])("rejects malformed create responses", async responseBody => {
    const fetch = vi.fn(async () => json(responseBody))
    const task = createMultipartUploader("/api/multipart", { fetch })(new File(["a"], "a.bin"))

    await expect(task.completed).rejects.toThrow("Upload request returned malformed JSON.")
  })

  it("rejects malformed part responses", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ pathname: "a.bin", uploadId: "u1" }))
      .mockResolvedValueOnce(json({ part: { etag: "p1", partNumber: "1" } }))
      .mockResolvedValue(json({ action: "abort" }))
    const task = createMultipartUploader("/api/multipart", { fetch, partSize: 1 })(new File(["a"], "a.bin"))

    await expect(task.completed).rejects.toThrow("Upload request returned malformed JSON.")
  })

  it("rejects malformed complete responses", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ pathname: "a.bin", uploadId: "u1" }))
      .mockResolvedValueOnce(json({ part: { etag: "p1", partNumber: 1 } }))
      .mockResolvedValueOnce(json({ object: { pathname: "a.bin" } }))
      .mockResolvedValue(json({ action: "abort" }))
    const task = createMultipartUploader("/api/multipart", { fetch, partSize: 1 })(new File(["a"], "a.bin"))

    await expect(task.completed).rejects.toThrow("Upload request returned malformed JSON.")
  })
})

describe("Vue composables", () => {
  it("returns one object when multiple is false", async () => {
    const fetch = vi.fn(async () => json([object]))

    await expect(useUpload("/api/files", { fetch, multiple: false })(new File(["a"], "a.txt"))).resolves.toEqual(object)
    await expect(useUpload("/api/files", { fetch })(new File(["a"], "a.txt"))).resolves.toEqual([object])
  })

  it("tracks multipart progress in a read-only ref", async () => {
    const { fetch } = multipartServer()
    const { completed, progress } = useMultipartUpload("/api/files/multipart", { fetch, partSize: 5 })(new File(["0123456789"], "big file.bin"))

    await completed
    expect(progress.value).toBe(100)
  })
})
