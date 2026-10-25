import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock("../src/console/runtime/client/request", async (original) => ({
  ...await original<typeof import("../src/console/runtime/client/request")>(),
  requestConsole: mocks.request,
}))

import { consoleBlobMediaFile, createConsoleBlobMediaClient, parseConsoleBlobPage } from "../src/console/runtime/client/blob-media"

function object(pathname: string, extra: Record<string, unknown> = {}) {
  return { customMetadata: {}, httpMetadata: {}, pathname, uploadedAt: "2026-10-15T11:00:00.000Z", ...extra }
}

function page(blobs: unknown[], extra: Record<string, unknown> = {}) {
  return { blobs, hasMore: false, limit: 100, prefix: "", store: "default", stores: ["default", "media"], ...extra }
}

describe("Console Blob media client", () => {
  beforeEach(() => mocks.request.mockReset())

  it("lists a folder with a folded listing and keeps the raw metadata", async () => {
    mocks.request.mockResolvedValueOnce(page([object("covers/a.png", { contentType: "image/png", httpEtag: "\"1\"", size: 2048 }), object("covers/")], { folders: ["covers/large"], cursor: "next", hasMore: true }))
    const onPage = vi.fn()
    const client = createConsoleBlobMediaClient("/api/_vitehub/console/blob", { onPage, store: "media" })
    const listing = await client.list({ folder: "covers" })

    expect(mocks.request).toHaveBeenCalledWith("/api/_vitehub/console/blob", { query: { cursor: undefined, folded: true, limit: undefined, prefix: "covers/", showVitehub: undefined, store: "media" } })
    expect(listing).toMatchObject({ access: { manage: true, read: true, write: true }, cursor: "next", folder: "covers", folders: ["covers/large"], hasMore: true, served: null })
    // A folder marker that ends in `/` is not a file.
    expect(listing.items.map(item => item.pathname)).toEqual(["covers/a.png"])
    expect(client.object("covers/a.png")).toMatchObject({ httpEtag: "\"1\"", size: 2048 })
    expect(onPage).toHaveBeenCalledWith(expect.objectContaining({ stores: ["default", "media"] }))
  })

  it("searches by prefix without folding and asks for ViteHub files only when shown", async () => {
    mocks.request.mockResolvedValueOnce(page([object("_vitehub/a.json")]))
    const client = createConsoleBlobMediaClient("/blob", { showVitehub: true, store: "default" })
    await client.list({ search: "_vi" })
    expect(mocks.request.mock.calls[0]![1].query).toMatchObject({ folded: undefined, prefix: "_vi", showVitehub: true })
  })

  it("filters a page by media type", async () => {
    mocks.request.mockResolvedValueOnce(page([object("a.png"), object("b.pdf"), object("c.bin")]))
    const listing = await createConsoleBlobMediaClient("/blob", { store: "default" }).list({ type: "image" })
    expect(listing.items.map(item => item.name)).toEqual(["a.png"])
  })

  it("opens an object that the browser has not listed yet", async () => {
    mocks.request.mockResolvedValueOnce(page([object("docs/a.md"), object("docs/a.md.bak")]))
    const client = createConsoleBlobMediaClient("/blob", { store: "default" })
    await expect(client.get("docs/a.md")).resolves.toMatchObject({ name: "a.md", pathname: "docs/a.md" })
    mocks.request.mockResolvedValueOnce(page([]))
    await expect(client.get("missing.txt")).rejects.toThrow("No object missing.txt in store default.")
  })

  it("deletes each object through blob.del and reports the ones that failed", async () => {
    mocks.request.mockResolvedValueOnce({ deleted: true }).mockRejectedValueOnce(new Error("Object is locked."))
    const client = createConsoleBlobMediaClient("/blob", { store: "media" })
    await expect(client.remove(["a.png", "b.png"])).resolves.toEqual({ failed: [{ message: "Object is locked.", pathname: "b.png" }], removed: ["a.png"] })
    expect(mocks.request).toHaveBeenNthCalledWith(1, "/blob", { body: { action: "del", pathname: "a.png", store: "media" }, method: "POST" })
  })

  it("uploads a file as base64 through blob.put", async () => {
    mocks.request.mockResolvedValueOnce({ object: object("docs/hi.txt", { contentType: "text/plain", size: 2 }) })
    const client = createConsoleBlobMediaClient("/blob", { store: "default" })
    const uploaded = await client.upload(new File(["hi"], "hi.txt", { type: "text/plain" }), { folder: "docs" })
    expect(mocks.request).toHaveBeenCalledWith("/blob", { body: { action: "put", contentType: "text/plain", data: "aGk=", pathname: "docs/hi.txt", store: "default" }, method: "POST" })
    expect(uploaded.file).toMatchObject({ name: "hi.txt", pathname: "docs/hi.txt" })
    expect(client.object("docs/hi.txt")).toBeDefined()
  })

  it("refuses a file above 8 MiB before it sends it", async () => {
    const client = createConsoleBlobMediaClient("/blob", { store: "default" })
    await expect(client.upload(new File([new Uint8Array(8 * 1024 * 1024 + 1)], "big.bin"))).rejects.toMatchObject({ status: 413 })
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it("has no folders to create or move", async () => {
    const client = createConsoleBlobMediaClient("/blob", { store: "default" })
    await expect(client.createFolder("", "new")).rejects.toMatchObject({ status: 405 })
    await expect(client.usage(["a.png"])).resolves.toEqual({})
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it("maps objects without a recorded type or size", () => {
    expect(consoleBlobMediaFile(object("logo.svg"))).toMatchObject({ contentType: "image/svg+xml", name: "logo.svg", size: Number.NaN })
    expect(consoleBlobMediaFile(object("data.bin", { contentType: "application/x-thing", size: 3 }))).toMatchObject({ contentType: "application/x-thing", size: 3 })
  })

  it("rejects invalid pages and metadata", () => {
    expect(() => parseConsoleBlobPage({ blobs: "nope", stores: [] })).toThrow("invalid Blob page")
    expect(() => parseConsoleBlobPage(page([{ pathname: "a" }]))).toThrow("invalid Blob object")
    expect(() => parseConsoleBlobPage(page([object("a", { httpMetadata: { a: 1 } })]))).toThrow("invalid Blob metadata")
  })
})
