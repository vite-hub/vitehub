import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { installStandardContext } from "@vite-hub/runtime/h3"
import { H3, setResponseHeader } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createDriver as createCloudflareDriver } from "../src/drivers/cloudflare-native.ts"
import { blobSignedRoute } from "../src/internal/fs-sign.ts"
import signedRoute, { handleSignedBlobRequest } from "../src/runtime/signed.ts"
import { blob } from "../src/runtime/storage.ts"
import { setBlobRuntimeConfig } from "../src/runtime/state.ts"
import { createBlobStorage } from "../src/storage.ts"

import type { BlobSignedRequest, BlobSize, ResolvedFsBlobStoreConfig } from "../src/types.ts"

const secret = "a-root-secret-of-at-least-32-characters"
const origin = "http://app.test"
let base: string

function configure(store: Partial<ResolvedFsBlobStoreConfig> = {}) {
  const config = { base, driver: "fs" as const, ...store }
  setBlobRuntimeConfig({ store: config, stores: { default: config, media: config } })
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "vitehub-blob-fs-sign-"))
  vi.stubEnv("VITEHUB_SECRET", secret)
  configure()
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  setBlobRuntimeConfig(undefined)
  await rm(base, { force: true, recursive: true })
})

async function sign(pathname: string, options: Parameters<typeof blob.sign>[1], store = "default"): Promise<BlobSignedRequest> {
  const [error, signed] = await blob.store(store).sign(pathname, options)
  if (error) throw error
  return signed
}

function send(url: string, init: RequestInit = {}): Promise<Response> {
  return handleSignedBlobRequest(new Request(new URL(url, origin), init))
}

async function rejection(response: Response) {
  return { status: response.status, ...await response.json() as { code: string } }
}

describe("signed requests of the fs driver", () => {
  it("serves a signed GET through serve()", async () => {
    await blob.put("private/notes.txt", "hello", { contentType: "text/plain" })
    const download = await sign("private/notes.txt", { expiresIn: 60, method: "GET" })

    expect(download).toMatchObject({ headers: {}, method: "GET" })
    expect(download.url).toMatch(new RegExp(`^${blobSignedRoute}/default/private/notes\\.txt\\?expires=\\d+&signature=[\\da-f]{64}$`))
    const response = await send(download.url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("hello")
    expect(response.headers.get("content-type")).toBe("text/plain")

    // The same headers as the serve route, so its rules for active content apply to signed links too.
    const served = await blob.serve(new Request(`${origin}/files/private/notes.txt`), "private/notes.txt")
    expect(Object.fromEntries(response.headers)).toEqual(Object.fromEntries(served.headers))
  })

  it("stores a signed PUT with its bound content type", async () => {
    const upload = await sign("uploads/a b.json", { contentType: "application/json", expiresIn: 60, maxSize: "1KB", method: "PUT" })
    expect(upload).toMatchObject({ headers: { "Content-Type": "application/json" }, method: "PUT" })
    expect(upload.url).toContain("/default/uploads/a%20b.json?")

    const response = await send(upload.url, { body: "{\"ok\":true}", headers: upload.headers, method: upload.method })
    expect(response.status).toBe(200)
    expect(response.headers.get("etag")).toBeTruthy()
    const [, object] = await blob.head("uploads/a b.json")
    expect(object).toMatchObject({ contentType: "application/json", size: 11 })
  })

  it("answers on the route that Nitro mounts under the app base URL", async () => {
    // Nitro mounts the route under its base URL and gives it the raw catch-all, so the base is not part of the path.
    // `urlBaseUrl` carries the base, so the link reaches that route.
    configure({ urlBaseUrl: `${origin}/app/` })
    const app = new H3({ onRequest: event => installStandardContext(event) })
    app.all(`/app${blobSignedRoute}/**`, signedRoute)
    await blob.put("private/50% off.txt", "hello")
    const download = await sign("private/50% off.txt", { expiresIn: 60, method: "GET" })
    const upload = await sign("uploads/ü.txt", { contentType: "text/plain", expiresIn: 60, method: "PUT" })
    expect(download.url.startsWith(`${origin}/app${blobSignedRoute}/default/private/50%25%20off.txt?`)).toBe(true)

    const read = await app.fetch(new Request(download.url))
    expect(read.status).toBe(200)
    expect(await read.text()).toBe("hello")
    const write = await app.fetch(new Request(upload.url, { body: "hallo", headers: upload.headers, method: "PUT" }))
    expect(write.status).toBe(200)
    expect(await (await blob.get("uploads/ü.txt"))[1]?.text()).toBe("hallo")
  })

  // `hubBlob()` with `nitro()` alone has no Standard Context. The route must keep its policy in both mounts.
  it.each([
    ["with Standard Context", true],
    ["without Standard Context", false],
  ])("keeps its private cache policy over a Cache-Control that middleware set, %s", async (_, standard) => {
    // H3 adds the headers that middleware set over the returned Response. A shared cache must not keep a signed
    // download after the link expires.
    const app = new H3(standard ? { onRequest: event => installStandardContext(event) } : {})
    app.use((event) => {
      setResponseHeader(event, "Cache-Control", "public, max-age=3600")
      event.res.headers.set("x-middleware", "yes")
    })
    app.all(`${blobSignedRoute}/**`, signedRoute)
    await blob.put("private/notes.txt", "hello", { contentType: "text/plain" })
    const download = await sign("private/notes.txt", { expiresIn: 60, method: "GET" })

    const full = await app.fetch(new Request(new URL(download.url, origin)))
    const range = await app.fetch(new Request(new URL(download.url, origin), { headers: { Range: "bytes=0-3" } }))
    const conditional = await app.fetch(new Request(new URL(download.url, origin), { headers: { "If-None-Match": full.headers.get("etag")! } }))

    expect([full.status, range.status, conditional.status]).toEqual([200, 206, 304])
    for (const response of [full, range, conditional]) {
      expect(response.headers.get("cache-control")).toBe("private, no-cache")
      expect(response.headers.get("x-middleware")).toBe("yes")
    }
  })

  it("signs links for a named store and with urlBaseUrl", async () => {
    configure({ urlBaseUrl: "https://files.example/" })
    await blob.store("media").put("cover.png", "png")
    const download = await sign("cover.png", { expiresIn: 60, method: "GET" }, "media")
    expect(download.url.startsWith(`https://files.example${blobSignedRoute}/media/cover.png?`)).toBe(true)
    expect((await send(download.url)).status).toBe(200)
  })

  it("rejects a link after it expires", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-10T12:00:00Z"), toFake: ["Date"] })
    await blob.put("notes.txt", "hello")
    const download = await sign("notes.txt", { expiresIn: 60, method: "GET" })

    vi.setSystemTime(new Date("2026-11-10T12:00:59Z"))
    expect((await send(download.url)).status).toBe(200)
    vi.setSystemTime(new Date("2026-11-10T12:01:00Z"))
    expect(await rejection(await send(download.url))).toMatchObject({ code: "BLOB_R0042", status: 403 })
  })

  it("rejects a tampered link", async () => {
    await blob.put("notes.txt", "hello")
    await blob.put("other.txt", "secret")
    const { url } = await sign("notes.txt", { expiresIn: 60, method: "GET" })
    const signature = new URL(url, origin).searchParams.get("signature")!
    const tampered = [
      url.replace("/notes.txt?", "/other.txt?"),
      url.replace("/default/", "/media/"),
      url.replace(/expires=(\d+)/, (_, expires: string) => `expires=${Number(expires) + 3600}`),
      url.replace(signature, `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`),
      url.replace(`signature=${signature}`, "signature=x"),
      url.replace(`&signature=${signature}`, ""),
    ]
    for (const link of tampered) {
      expect(await rejection(await send(link)), link).toMatchObject({ code: "BLOB_R0041", status: 403 })
    }
  })

  it("rejects a link that another root secret signed", async () => {
    await blob.put("notes.txt", "hello")
    const { url } = await sign("notes.txt", { expiresIn: 60, method: "GET" })
    vi.stubEnv("VITEHUB_SECRET", "another-root-secret-of-32-characters")
    expect(await rejection(await send(url))).toMatchObject({ code: "BLOB_R0041", status: 403 })
    // The key comes from the secret, not from the process: a new runtime with the same secret accepts the link.
    vi.stubEnv("VITEHUB_SECRET", secret)
    configure()
    expect((await send(url)).status).toBe(200)
  })

  it("rejects the wrong method", async () => {
    await blob.put("notes.txt", "hello")
    const download = await sign("notes.txt", { expiresIn: 60, method: "GET" })
    const upload = await sign("notes.txt", { expiresIn: 60, method: "PUT" })

    expect(await rejection(await send(download.url, { body: "changed", method: "PUT" }))).toMatchObject({ code: "BLOB_R0041", status: 403 })
    expect(await rejection(await send(upload.url))).toMatchObject({ code: "BLOB_R0041", status: 403 })
    const deleted = await send(download.url, { method: "DELETE" })
    expect(deleted.headers.get("allow")).toBe("GET, PUT")
    expect(await rejection(deleted)).toMatchObject({ code: "BLOB_R0041", status: 405 })
    expect(await (await blob.get("notes.txt"))[1]?.text()).toBe("hello")
  })

  it("rejects another content type than the link binds", async () => {
    const upload = await sign("avatar.png", { contentType: "image/png", expiresIn: 60, method: "PUT" })
    const response = await send(upload.url, { body: "<svg/>", headers: { "Content-Type": "image/svg+xml" }, method: "PUT" })
    expect(await rejection(response)).toMatchObject({ code: "BLOB_R0041", status: 403 })
    expect((await blob.head("avatar.png"))[1]).toBeNull()
  })

  it("rejects a body larger than maxSize", async () => {
    const upload = await sign("avatar.png", { expiresIn: 60, maxSize: "4B", method: "PUT" })

    const declared = await send(upload.url, { body: "12345", method: "PUT" })
    expect(await rejection(declared)).toMatchObject({ code: "BLOB_R0043", status: 413 })

    // A stream has no Content-Length, so the route counts the bytes as they arrive.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123"))
        controller.enqueue(new TextEncoder().encode("45"))
        controller.close()
      },
    })
    const streamed = await send(upload.url, { body: stream, duplex: "half", method: "PUT" } as RequestInit)
    expect(await rejection(streamed)).toMatchObject({ code: "BLOB_R0043", status: 413 })
    expect((await blob.head("avatar.png"))[1]).toBeNull()

    expect((await send(upload.url, { body: "1234", method: "PUT" })).status).toBe(200)
  })

  it("fails to sign without a root secret, createOnly, or a valid maxSize", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    vi.stubEnv("NUXT_APP_SECRET", "")
    const [missing] = await blob.sign("notes.txt", { expiresIn: 60, method: "GET" })
    expect(missing).toMatchObject({ code: "BLOB_OPERATION_FAILED", cause: { code: "BLOB_R0040" } })
    vi.stubEnv("VITEHUB_SECRET", "short")
    const [short] = await blob.sign("notes.txt", { expiresIn: 60, method: "GET" })
    expect(short).toMatchObject({ cause: { code: "BLOB_R0040" } })

    vi.stubEnv("VITEHUB_SECRET", secret)
    const [createOnly] = await blob.sign("notes.txt", { createOnly: true, expiresIn: 60, method: "PUT" })
    expect(createOnly).toMatchObject({ code: "BLOB_OPERATION_FAILED", cause: { code: "BLOB_R0025" } })
    // SAFETY: A JavaScript caller can pass a size that the type rejects.
    await expect(blob.sign("notes.txt", { expiresIn: 60, maxSize: "8 megabytes" as BlobSize, method: "PUT" })).rejects.toMatchObject({ code: "BLOB_R0039" })
  })

  it("does not let a hosted driver ignore maxSize", async () => {
    const storage = createBlobStorage(createCloudflareDriver({
      accountId: "account",
      accessKeyId: "access-key",
      binding: "BLOB",
      bucketName: "private-audio",
      driver: "cloudflare-r2",
      secretAccessKey: "secret-key",
    }))
    const [error] = await storage.sign("audio.mp3", { expiresIn: 60, maxSize: "8MB", method: "PUT" })
    expect(error).toMatchObject({ code: "BLOB_OPERATION_FAILED", cause: { code: "BLOB_R0025" } })
  })
})
