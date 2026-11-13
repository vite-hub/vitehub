import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { H3 } from "h3"
import { beforeEach, expect, it, onTestFinished, vi } from "vitest"

const { getItem, parsed, useKV } = vi.hoisted(() => ({ getItem: vi.fn(), parsed: vi.fn(), useKV: vi.fn() }))
vi.mock("nitro/kv", () => ({ useKV }))
// Development has no packed files, so the handlers read Nitro server assets.
vi.mock("#docs/files", () => ({ default: null }))
vi.mock("#docs/content", () => ({ content: undefined }))
vi.mock("#docs/example-sources", () => ({ default: {} }))
vi.mock("#docs/parser", () => ({ default: { plugins: [{ name: "count-parses", post: parsed }] }, githubRepo: null }))
vi.mock("#docs/manifest", async () => {
  const { createDocsManifest } = await import("../src/manifest.ts")
  return {
    default: await createDocsManifest({
      dir: resolve(import.meta.dirname, "fixtures/content"),
      base: "/docs",
    }),
  }
})

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  useKV.mockImplementation(() => ({ getItem }))
  getItem.mockImplementation((key: string) =>
    readFile(resolve(import.meta.dirname, "fixtures/content", key), "utf8"),
  )
})

async function app() {
  const { default: page } = await import("../src/runtime/server/page.ts")
  const { default: search } = await import("../src/runtime/server/search.ts")
  return new H3().get("/api/_docs/page/**", page).get("/api/_docs/search.json", search)
}

it("parses each page once for concurrent page and search requests", async () => {
  const server = await app()
  const page = () =>
    server.fetch(new Request("https://docs.example.com/api/_docs/page/docs/kv.json"))
  const search = () => server.fetch(new Request("https://docs.example.com/api/_docs/search.json"))
  const responses = await Promise.all([page(), page(), search()])
  for (const response of responses) expect(response.status).toBe(200)
  expect(await responses[0]!.json()).toMatchObject({ page: { path: "/docs/kv" } })
  expect(await responses[2]!.json()).toContainEqual(expect.objectContaining({ id: "/docs/kv" }))
  // The page route and search read the same Content, so each file is read and parsed once.
  const files = getItem.mock.calls.map(([file]) => file)
  expect(files).toContain("docs/kv/index.md")
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

it("serves a page from the parse that built the search index", async () => {
  const server = await app()
  const search = () => server.fetch(new Request("https://docs.example.com/api/_docs/search.json"))
  expect((await search()).status).toBe(200)
  const reads = getItem.mock.calls.length
  expect((await search()).status).toBe(200)
  const response = await server.fetch(
    new Request("https://docs.example.com/api/_docs/page/docs/kv.json"),
  )
  expect(response.status).toBe(200)
  expect(getItem).toHaveBeenCalledTimes(reads)
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

it("keeps identical file names apart for each mapped source", async () => {
  const { default: manifest } = await import("#docs/manifest")
  const { findDocsPage } = await import("../src/navigation.ts")
  const page = findDocsPage(manifest, "/docs/kv")!.page
  const source = page.source
  onTestFinished(() => { page.source = source })
  page.source = "docs-1"
  const reads = vi.fn(async (base: string) => `# ${base}`)
  useKV.mockImplementation((base: string) => ({ getItem: () => reads(base) }))
  const { readDocsPage } = await import("../src/runtime/content.ts")
  const load = (source?: string) => readDocsPage({ file: page.file, source })
  const [first, second] = await Promise.all([load(), load("docs-1")])
  expect(JSON.stringify(first)).toContain("assets:docs")
  expect(JSON.stringify(second)).toContain("assets:docs-1")
  expect(first).not.toEqual(second)
  expect(await load()).toEqual(first)
  expect(await load("docs-1")).toEqual(second)
  expect(reads.mock.calls).toEqual([["assets:docs"], ["assets:docs-1"]])
})

it("reads mapped page and search content from the configured storage mount", async () => {
  const { default: manifest } = await import("#docs/manifest")
  const { findDocsPage } = await import("../src/navigation.ts")
  const page = findDocsPage(manifest, "/docs/kv")!.page
  const source = page.source
  onTestFinished(() => { page.source = source })
  page.source = "docs-1"
  const mapped = vi.fn(async () => "# Mapped page\n\nOnly in mapped content.")
  useKV.mockImplementation((base: string) => ({ getItem: base === "assets:docs-1" ? mapped : getItem }))
  const server = await app()
  const response = await server.fetch(new Request("https://docs.example.com/api/_docs/page/docs/kv.json"))
  expect(response.status).toBe(200)
  expect(JSON.stringify(await response.json())).toContain("Only in mapped content.")
  const search = await server.fetch(new Request("https://docs.example.com/api/_docs/search.json"))
  expect(search.status).toBe(200)
  expect(JSON.stringify(await search.json())).toContain("Only in mapped content.")
  // The page route and search share one read.
  expect(mapped).toHaveBeenCalledExactlyOnceWith(page.file)
})

it("gives the page route the same document as the docs parser", async () => {
  const markdown = [
    "---\ntitle: Same\n---\n",
    "# Same\n\n- one\n\n- two\n",
    ":::example\n```md\n## Install\n\n- [ ] task\n```\n:::\n",
    "## Install\n\n> [!NOTE]\n> Read this.\n",
    "::diff\n```ts\nconst a = 1\n```\n```ts\nconst a = 2\n```\n::\n",
    "::question{#callback}\nWhich callback runs first?\n\n- [x] A promise\n- [ ] A timer\n::\n",
  ].join("\n")
  getItem.mockResolvedValue(markdown)
  const server = await app()
  const response = await server.fetch(new Request("https://docs.example.com/api/_docs/page/docs/kv.json"))
  expect(response.status).toBe(200)
  const { document } = await response.json()
  const { parseDocsDocument } = await import("../src/runtime/documents.ts")
  expect(document).toEqual(JSON.parse(JSON.stringify(await parseDocsDocument(markdown))))
  expect(JSON.stringify(document)).toContain("comark-html")
  expect(document.toc).toEqual([expect.objectContaining({ text: "Install" })])
})
