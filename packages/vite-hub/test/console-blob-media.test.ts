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
    expect(listing).toMatchObject({ access: { manage: false, read: true, write: false }, cursor: "next", folder: "covers", folders: ["covers/large"], hasMore: true, served: null })
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

  it("rejects every write, since the Blob section is read-only", async () => {
    const client = createConsoleBlobMediaClient("/blob", { store: "default" })
    await expect(client.remove(["a.png"])).rejects.toThrow("read-only")
    await expect(client.createFolder("", "new")).rejects.toThrow("read-only")
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
