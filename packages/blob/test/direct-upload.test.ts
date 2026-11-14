import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getPayloadFromClientToken } from "@vercel/blob/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const vercel = vi.hoisted(() => ({
  del: vi.fn(async () => {}),
  head: vi.fn(),
}))

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vercel/blob")>()
  return { ...actual, del: vercel.del, head: vercel.head }
})

import { uploadFiles } from "../src/client.ts"
import { createDriver as createFsDriver } from "../src/drivers/fs.ts"
import { createBundledVercelBlobDriver } from "../src/drivers/vercel-bundled.ts"
import { handleSignedBlobRequest } from "../src/runtime/signed.ts"
import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { Result } from "@vite-hub/runtime"

import type { BlobDirectUploadStep, BlobErrorCode, BlobObject, BlobStorage, BlobUploadOptions } from "../src/types.ts"

const secret = "a-root-secret-of-at-least-32-characters"
const origin = "http://app.test"
const route = `${origin}/api/files`
let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-blob-direct-"))
  vi.stubEnv("VITEHUB_SECRET", secret)
  const config = { base, driver: "fs" as const }
  setBlobRuntimeConfig({ store: config, stores: { default: config } })
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  setBlobRuntimeConfig(undefined)
  await rm(base, { force: true, recursive: true })
})

function ok<T>(result: Result<T, BlobErrorCode>): T {
  const [error, value] = result
  if (error) throw error
  return value
}

function step(body: Record<string, unknown>, url = route): Request {
  return new Request(url, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" })
}

async function sign(storage: BlobStorage, file: { contentType: string, name: string, size: number }, options: BlobUploadOptions = {}) {
  const result = ok(await storage.handleUpload(step({ action: "sign", ...file }), { ...options, direct: true }))
  if (Array.isArray(result) || result.action !== "sign") throw new TypeError("Expected a sign step.")
  return result
}

async function complete(storage: BlobStorage, ticket: string, options: BlobUploadOptions = {}, url = route): Promise<BlobObject[] | BlobDirectUploadStep> {
  return ok(await storage.handleUpload(step({ action: "complete", ticket }, url), { ...options, direct: true }))
}

describe("direct uploads on the fs driver", () => {
  it.each(["direct", "runtime"])("rejects cross-store tickets through %s handles before touching another store's object", async (mode) => {
    const stores = {
      a: { base: join(base, "a"), driver: "fs" as const },
      b: { base: join(base, "b"), driver: "fs" as const },
    }
    setBlobRuntimeConfig({ store: stores.a, stores: { default: stores.a, ...stores } })
    const a = mode === "runtime" ? blob.store("a") : createBlobStorage(createFsDriver(stores.a), "a")
    const b = mode === "runtime" ? blob.store("b") : createBlobStorage(createFsDriver(stores.b), "b")
    ok(await b.put("invoice.txt", "private invoice", { contentType: "text/plain" }))
    const signed = await sign(a, { contentType: "text/plain", name: "invoice.txt", size: 1 })
    const onCompleted = vi.fn()
    const head = vi.spyOn(b, "head")
    const remove = vi.spyOn(b, "delete")
    for (const ensure of [undefined, { maxSize: "1B" }]) {
      await expect(complete(b, signed.ticket, { ensure, onCompleted })).rejects.toMatchObject({ statusCode: 403 })
    }
    expect(head).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
    expect(ok(await b.head("invoice.txt"))).toMatchObject({ size: 15 })
  })

  it("signs, takes the PUT on the signed route, and completes with onCompleted", async () => {
    const onCompleted = vi.fn()
    const onBeforeUpload = vi.fn(({ pathname }: { pathname: string }) => ({ pathname: `avatars/${pathname}` }))
    const options = { ensure: { maxSize: "1KB", types: ["text"] }, onBeforeUpload, onCompleted } satisfies BlobUploadOptions

    const signed = await sign(blob, { contentType: "text/plain", name: "../notes.txt", size: 5 }, options)
    expect(onBeforeUpload).toHaveBeenCalledWith(expect.objectContaining({ contentType: "text/plain", pathname: "notes.txt", size: 5 }))
    expect(signed).toMatchObject({ action: "sign", pathname: "avatars/notes.txt", request: { headers: { "Content-Type": "text/plain" }, method: "PUT" } })
    // `fs` binds the `maxSize` of `ensure` into the link.
    expect(signed.request.url).toContain("max-size=1024")

    const put = await handleSignedBlobRequest(new Request(new URL(signed.request.url, origin), { body: "hello", headers: signed.request.headers, method: "PUT" }))
    expect(put.status).toBe(200)

    const [object] = await complete(blob, signed.ticket, options) as BlobObject[]
    expect(object).toMatchObject({ contentType: "text/plain", pathname: "avatars/notes.txt", size: 5 })
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({ pathname: "avatars/notes.txt" }), expect.any(Request))
  })

  it("rejects a file at sign time from its declared type and size", async () => {
    const options = { ensure: { maxSize: "1KB", types: ["image"] } } satisfies BlobUploadOptions
    await expect(sign(blob, { contentType: "text/html", name: "a.html", size: 5 }, options)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("File type is invalid") })
    await expect(sign(blob, { contentType: "image/png", name: "a.png", size: 4096 }, options)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("File size must be less than 1KB") })
  })

  it("lets onBeforeUpload reject a file", async () => {
    const onBeforeUpload = () => {
      throw Object.assign(new TypeError("Not yours."), { statusCode: 403 })
    }
    await expect(sign(blob, { contentType: "text/plain", name: "a.txt", size: 1 }, { onBeforeUpload })).rejects.toMatchObject({ statusCode: 403 })
  })

  it("deletes the object and fails at complete when the stored file breaks ensure", async () => {
    const onCompleted = vi.fn()
    const options = { ensure: { maxSize: "1KB" }, onCompleted } satisfies BlobUploadOptions
    // The client declares 10 bytes. A provider that cannot bind `maxSize`, such as S3, stores what the client sends.
    const signed = await sign(blob, { contentType: "text/plain", name: "lie.txt", size: 10 }, options)
    ok(await blob.put(signed.pathname, "x".repeat(4096), { contentType: "text/plain" }))

    await expect(complete(blob, signed.ticket, options)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("File size must be less than 1KB") })
    expect(ok(await blob.head(signed.pathname))).toBeNull()
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it("accepts only its own ticket for an object that was stored", async () => {
    const signed = await sign(blob, { contentType: "text/plain", name: "a.txt", size: 1 })
    await expect(complete(blob, signed.ticket)).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("is not in the store") })
    await expect(complete(blob, `${signed.ticket.slice(0, -1)}0`)).rejects.toMatchObject({ statusCode: 403 })
    await expect(complete(blob, signed.ticket, {}, `${origin}/api/other`)).rejects.toMatchObject({ statusCode: 403 })
  })

  it("rejects a JSON step on a route without direct mode", async () => {
    await expect(blob.handleUpload(step({ action: "sign", contentType: "text/plain", name: "a.txt", size: 1 }))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("Pass `direct: true`"),
    })
  })

  it("rejects put options that a signed PUT cannot carry", async () => {
    await expect(sign(blob, { contentType: "text/plain", name: "a.txt", size: 1 }, { put: { customMetadata: { owner: "u1" } } })).rejects.toMatchObject({ code: "BLOB_R0046" })
  })

  it("runs the hooks for a form too", async () => {
    const onCompleted = vi.fn()
    const form = new FormData()
    form.append("files", new File(["hello"], "a.txt", { type: "text/plain" }))
    const objects = ok(await blob.handleUpload(new Request(route, { body: form, method: "POST" }), {
      onBeforeUpload: ({ pathname }) => ({ pathname: `forms/${pathname}` }),
      onCompleted,
    }))
    expect(objects).toMatchObject([{ pathname: "forms/a.txt" }])
    expect(onCompleted).toHaveBeenCalledOnce()
  })
})

describe("direct uploads without signing", () => {
  it("tells the client to send a form when the driver cannot sign", async () => {
    const { sign: _sign, ...driver } = createFsDriver({ base, driver: "fs" })
    const storage = createBlobStorage(driver, "default")
    const result = ok(await storage.handleUpload(step({ action: "sign", contentType: "text/plain", name: "a.txt", size: 1 }), { direct: true }))
    expect(result).toEqual({ action: "form" })
  })
})

describe("direct uploads on Vercel Blob", () => {
  const token = "vercel_blob_rw_store123_secretpart"

  function vercelStorage() {
    return createBlobStorage(createBundledVercelBlobDriver({ access: "private", driver: "vercel-blob", token }), "default")
  }

  it("signs a client token that binds the pathname, the type, and the size", async () => {
    const signed = await sign(vercelStorage(), { contentType: "image/png", name: "cat.png", size: 2048 }, { ensure: { maxSize: "8MB", types: ["image"] } })
    expect(signed.request).toMatchObject({
      headers: { "x-api-version": "12", "x-content-type": "image/png", "x-vercel-blob-access": "private" },
      method: "PUT",
      url: "https://vercel.com/api/blob/?pathname=cat.png",
    })
    const clientToken = signed.request.headers.authorization!.replace(/^Bearer /, "")
    expect(clientToken.startsWith("vercel_blob_client_store123_")).toBe(true)
    expect(getPayloadFromClientToken(clientToken)).toMatchObject({
      allowedContentTypes: ["image/png"],
      allowOverwrite: true,
      maximumSizeInBytes: 8 * 1024 * 1024,
      pathname: "cat.png",
    })
    // Vercel checks the HMAC that `@vercel/blob/client` computes with the read-write token.
    const [signature, payload] = Buffer.from(clientToken.split("_").pop()!, "base64").toString().split(".")
    expect(signature).toBe(createHmac("sha256", token).update(payload!).digest("hex"))
  })

  it("completes from the Vercel metadata and deletes a file of the wrong type", async () => {
    const storage = vercelStorage()
    const onCompleted = vi.fn()
    const options = { ensure: { types: ["image"] }, onCompleted } satisfies BlobUploadOptions
    const signed = await sign(storage, { contentType: "image/png", name: "cat.png", size: 3 }, options)

    vercel.head.mockResolvedValueOnce({ contentType: "image/png", pathname: "cat.png", size: 3, uploadedAt: new Date(), url: "https://store123.private.blob.vercel-storage.com/cat.png" })
    expect(await complete(storage, signed.ticket, options)).toMatchObject([{ contentType: "image/png", pathname: "cat.png", size: 3 }])
    expect(onCompleted).toHaveBeenCalledOnce()

    vercel.head.mockResolvedValueOnce({ contentType: "text/html", pathname: "cat.png", size: 3, uploadedAt: new Date(), url: "https://store123.private.blob.vercel-storage.com/cat.png" })
    await expect(complete(storage, signed.ticket, options)).rejects.toMatchObject({ statusCode: 400 })
    expect(vercel.del).toHaveBeenCalledWith(["cat.png"], { token })
  })

  it("cannot sign a GET or without a read-write token", async () => {
    const [getError] = await vercelStorage().sign("a.txt", { expiresIn: 60, method: "GET" })
    expect(getError).toMatchObject({ cause: { code: "BLOB_R0025" } })
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "")
    const oidc = createBlobStorage(createBundledVercelBlobDriver({ access: "private", driver: "vercel-blob" }), "default")
    const [putError] = await oidc.sign("a.txt", { expiresIn: 60, method: "PUT" })
    expect(putError).toMatchObject({ cause: { code: "BLOB_R0025" } })
  })
})

describe("uploadFiles({ direct: true })", () => {
  it("runs sign, PUT, and complete against a real fs route", async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname.startsWith("/_vitehub/blob/signed/")) return handleSignedBlobRequest(request)
      expect(request.headers.get("authorization")).toBe("Bearer app")
      const [error, result] = await blob.handleUpload(request, { direct: true, ensure: { maxSize: "1KB" } })
      if (error) throw error
      return Response.json(result)
    })
    const objects = await uploadFiles(route, [new File(["hello"], "a.txt", { type: "text/plain" }), new File(["bye"], "b.txt", { type: "text/plain" })], {
      direct: true,
      fetch,
      headers: { authorization: "Bearer app" },
    })
    expect(objects).toMatchObject([{ pathname: "a.txt", size: 5 }, { pathname: "b.txt", size: 3 }])
    // The signed PUT does not carry the app headers.
    const puts = fetch.mock.calls.filter(([, init]) => init?.method === "PUT")
    expect(puts).toHaveLength(2)
    for (const [, init] of puts) expect(new Headers(init?.headers).has("authorization")).toBe(false)
  })

  it("sends a form when the route answers form", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (typeof init?.body === "string") return Response.json({ action: "form" })
      return Response.json([{ contentType: "text/plain", customMetadata: {}, httpEtag: undefined, httpMetadata: {}, pathname: "a.txt", size: 5, uploadedAt: "2026-01-01T00:00:00.000Z" }])
    })
    await expect(uploadFiles("/api/files", [new File(["hello"], "a.txt")], { direct: true, fetch })).resolves.toMatchObject([{ pathname: "a.txt" }])
    expect(fetch.mock.calls[1]![1]!.body).toBeInstanceOf(FormData)
  })
})
