import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { H3 } from "h3"
import { beforeEach, expect, it, onTestFinished, vi } from "vitest"

const { getItem, parsed } = vi.hoisted(() => ({ getItem: vi.fn(), parsed: vi.fn() }))
vi.mock("#imports", async () => ({
  ...(await import("h3")),
  useStorage: () => ({ getItem }),
}))
vi.mock("#docs/content", () => ({ content: undefined }))
vi.mock("#docs/parser", () => ({ default: { plugins: [{ name: "count-parses", post: parsed }] } }))
vi.mock("#docs/manifest", async () => {
  const { createDocsManifest } = await import("../src/manifest.ts")
  return {
    default: createDocsManifest({
      dir: resolve(import.meta.dirname, "fixtures/content"),
      base: "/docs",
    }),
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  getItem.mockImplementation((key: string) =>
    readFile(resolve(import.meta.dirname, "fixtures/content", key), "utf8"),
  )
})

async function app() {
  const { default: page } = await import("../src/runtime/server/page.ts")
  const { default: search } = await import("../src/runtime/server/search.ts")
  return new H3().get("/api/_docs/page/**", page).get("/api/_docs/search.json", search)
}

it("shares each page parse between concurrent page and search requests", async () => {
  const server = await app()
  const page = () =>
    server.fetch(new Request("https://docs.example.com/api/_docs/page/docs/kv.json"))
  const search = () => server.fetch(new Request("https://docs.example.com/api/_docs/search.json"))
  const responses = await Promise.all([page(), page(), search()])
  for (const response of responses) expect(response.status).toBe(200)
  expect(await responses[0]!.json()).toMatchObject({ page: { path: "/docs/kv" } })
  expect(await responses[2]!.json()).toContainEqual(expect.objectContaining({ id: "/docs/kv" }))
  const files = getItem.mock.calls.map(([file]) => file)
  expect(new Set(files).size).toBe(files.length)
  expect(parsed).toHaveBeenCalledTimes(files.length)
  await page()
  await search()
  expect(getItem).toHaveBeenCalledTimes(files.length)
  expect(parsed).toHaveBeenCalledTimes(files.length)
})

it("retries a page after storage or parsing fails", async () => {
  const server = await app()
  const request = () =>
    server.fetch(new Request("https://docs.example.com/api/_docs/page/docs/kv.json"))
  getItem.mockImplementationOnce(() => { throw new Error("Storage unavailable"); })
  expect((await request()).status).toBe(500)
  parsed.mockImplementationOnce(() => {
    throw new Error("Parser unavailable")
  })
  expect((await request()).status).toBe(500)
  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ page: { path: "/docs/kv" } })
})

it("keeps the compact search index without retaining every document tree", async () => {
  const server = await app()
  const search = () => server.fetch(new Request("https://docs.example.com/api/_docs/search.json"))
  expect((await search()).status).toBe(200)
  const reads = getItem.mock.calls.length
  expect((await search()).status).toBe(200)
  expect(getItem).toHaveBeenCalledTimes(reads)
  const response = await server.fetch(
    new Request("https://docs.example.com/api/_docs/page/docs/kv.json"),
  )
  expect(response.status).toBe(200)
  expect(getItem).toHaveBeenCalledTimes(reads + 1)
})

it("returns parsed credits beside a cached page document", async () => {
  const { default: manifest } = await import("#docs/manifest")
  const { findDocsPage } = await import("../src/navigation.ts")
  const page = findDocsPage(manifest, "/docs/kv")!.page
  const credits = page.credits
  onTestFinished(() => { page.credits = credits })
  page.credits = "Built with [Comark](https://comark.dev)."
  const server = await app()
  for (let i = 0; i < 2; i++) {
    const response = await server.fetch(new Request("https://docs.example.com/api/_docs/page/docs/kv.json"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      credits: { nodes: [["p", {}, "Built with ", ["a", { href: "https://comark.dev" }, "Comark"], "."]] },
    })
  }
  expect(getItem).toHaveBeenCalledTimes(1)
})

it("keeps page keywords in the cached search index", async () => {
  const { default: manifest } = await import("#docs/manifest")
  const { findDocsPage } = await import("../src/navigation.ts")
  const page = findDocsPage(manifest, "/docs/kv")!.page
  const keywords = page.keywords
  onTestFinished(() => { page.keywords = keywords })
  page.keywords = ["key value", "TTL"]
  const server = await app()
  for (let i = 0; i < 2; i++) {
    const response = await server.fetch(new Request("https://docs.example.com/api/_docs/search.json"))
    expect(response.status).toBe(200)
    expect(await response.json()).toContainEqual(expect.objectContaining({
      id: "/docs/kv", keywords: ["key value", "TTL"],
    }))
  }
})
