import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { H3 } from "h3"
import { beforeEach, expect, it, onTestFinished, vi } from "vitest"

const { getItem, parsed, read } = vi.hoisted(() => ({ getItem: vi.fn(), parsed: vi.fn(), read: vi.fn() }))
// Development has no packed files, so the handlers read each file on its own.
vi.mock("#docs/files", () => ({ default: { read } }))
vi.mock("#docs/content", () => ({ content: undefined }))
vi.mock("#docs/example-sources", () => ({ default: {} }))
vi.mock("#docs/image-sizes", () => ({ default: {} }))
vi.mock("#docs/agent", () => ({ default: { llms: {} } }))
vi.mock("nitro", () => ({ serverFetch: () => new Response(null, { status: 404 }) }))
vi.mock("nitro/runtime-config", () => ({ useRuntimeConfig: () => ({ public: { docs: { appBase: "/", site: { name: "Docs", url: "", description: "" }, mcp: false } } }) }))
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
  read.mockImplementation((_store: string, file: string) => getItem(file))
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

it.each([undefined, "docs-1"])("reads packed production pages from %s through Content without Nitro server assets", async (source) => {
  const { default: manifest } = await import("#docs/manifest")
  const { findDocsPage } = await import("../src/navigation.ts")
  const page = findDocsPage(manifest, "/docs/kv")!.page
  const original = page.source
  page.source = source
  onTestFinished(() => { page.source = original })
  const markdown = "# Packed page\n\nOnly in the production bundle.\n"
  const bytes = Buffer.from(markdown)
  const rewritten = Buffer.from("# Agent copy\n\nRewritten for agents.\n")
  const agentSource = `docs_${source ? source.slice("docs-".length) : 0}`
  vi.doMock("#docs/files", () => ({ default: {
    index: { [source ?? "docs"]: { [page.file]: [0, bytes.length] }, "docs-agent": { [`${agentSource}/${page.file}`]: [bytes.length, bytes.length + rewritten.length] } },
    packed: gzipSync(Buffer.concat([bytes, rewritten])).toString("base64"),
  } }))
  onTestFinished(() => { vi.doMock("#docs/files", () => ({ default: { read } })) })
  getItem.mockResolvedValue(null)
  const server = await app()
  const response = await server.fetch(new Request("https://docs.example.com/api/_docs/page/docs/kv.json"))
  expect(response.status).toBe(200)
  expect(JSON.stringify(await response.json())).toContain("Only in the production bundle.")
  const { docsContent } = await import("../src/runtime/content.ts")
  const { default: raw } = await import("../src/runtime/server/raw.ts")
  const rawServer = new H3().get("/raw/**", raw)
  const copy = await (await rawServer.fetch(new Request("https://docs.example.com/raw/docs/kv.md"))).text()
  expect(copy).toContain("Rewritten for agents.")
  expect(copy).not.toContain("Only in the production bundle.")
  expect((await docsContent().page("/docs/kv"))?.content).toContain("Rewritten for agents.")
  expect(read).not.toHaveBeenCalled()
})

it("serves exact raw URLs and reads only the requested page on a cold runtime", async () => {
  const { default: manifest } = await import("#docs/manifest")
  const { findDocsPage } = await import("../src/navigation.ts")
  const page = findDocsPage(manifest, "/docs/kv")!.page
  const fixtures = [
    { ...page, path: "/docs/Guide", file: "upper.md" },
    { ...page, path: "/docs/guide", file: "lower.md" },
    { ...page, path: "/docs/missing", file: "missing.md" },
  ]
  manifest.pages.push(...fixtures)
  onTestFinished(() => { manifest.pages.splice(-fixtures.length) })
  read.mockImplementation((store: string, file: string) => store === "docs" && file !== "missing.md" ? `Body of ${file}` : null)
  const { default: raw } = await import("../src/runtime/server/raw.ts")
  const { default: markdown } = await import("../src/runtime/server/markdown.ts")
  const server = new H3().use(markdown).get("/raw/**", raw)
  const request = (path: string) => server.fetch(new Request(`https://docs.example.com${path}`))

  expect(await (await request("/docs/Guide.md")).text()).toContain("Body of upper.md")
  expect(read.mock.calls.filter(([store]) => store === "docs")).toEqual([["docs", "upper.md"]])
  expect(await (await request("/raw/docs/Guide.md")).text()).toContain("Body of upper.md")
  expect(await (await request("/raw/docs/guide.md")).text()).toContain("Body of lower.md")
  for (const path of ["/raw/docs/GUIDE.md", "/raw/docs/guide/.md", "/raw/docs/missing.md"]) {
    expect((await request(path)).status).toBe(404)
  }
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
  const reads = vi.fn(async (store: string) => `# From ${store}.`)
  read.mockImplementation((store: string) => reads(store))
  const { readDocsPage } = await import("../src/runtime/content.ts")
  const load = (source?: string) => readDocsPage({ file: page.file, source })
  const [first, second] = await Promise.all([load(), load("docs-1")])
  expect(JSON.stringify(first)).toContain("From docs.")
  expect(JSON.stringify(second)).toContain("From docs-1.")
  expect(first).not.toEqual(second)
  expect(await load()).toEqual(first)
  expect(await load("docs-1")).toEqual(second)
  expect(reads.mock.calls).toEqual([["docs"], ["docs-1"]])
})

it("reads mapped page and search content from the configured storage mount", async () => {
  const { default: manifest } = await import("#docs/manifest")
  const { findDocsPage } = await import("../src/navigation.ts")
  const page = findDocsPage(manifest, "/docs/kv")!.page
  const source = page.source
  onTestFinished(() => { page.source = source })
  page.source = "docs-1"
  const mapped = vi.fn(async (_file: string) => "# Mapped page\n\nOnly in mapped content.")
  read.mockImplementation((store: string, file: string) => store === "docs-1" ? mapped(file) : getItem(file))
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

it("searches unloaded panel pages while excluding hidden pages on the server", async () => {
  const { default: manifest } = await import("#docs/manifest")
  const { docsAppManifest } = await import("../src/manifest.ts")
  const { createDocsSearch, docsManifestPages } = await import("../src/navigation.ts")
  const section = manifest.sections.find(section => section.id === "kv")!
  const original = section.pages
  onTestFinished(() => { section.pages = original })
  const page = original[0]!
  section.pages = [
    ...original,
    { ...page, id: "diagnostics", path: "/docs/kv/diagnostics", panel: true },
    { ...page, id: "diagnostics/kv_invalid_cursor", path: "/docs/kv/diagnostics/kv_invalid_cursor", sourceTitle: "KV_INVALID_CURSOR", seo: { index: false }, navigation: true },
    { ...page, id: "hidden", path: "/docs/kv/hidden", navigation: false },
    { ...page, id: "hidden-code", path: "/docs/kv/hidden-code", seo: { index: false }, navigation: false },
  ]
  const appManifest = docsAppManifest(manifest, { panels: true }).manifest
  expect(docsManifestPages(appManifest).some(page => page.path.endsWith("/kv_invalid_cursor"))).toBe(false)
  const server = await app()
  const response = await server.fetch(new Request("https://docs.example.com/api/_docs/search.json"))
  expect(response.status).toBe(200)
  const records = await response.json()
  expect(createDocsSearch(records)("KV_INVALID_CURSOR", 12).map(record => record.id)).toContain("/docs/kv/diagnostics/kv_invalid_cursor")
  expect(records.some((record: { id: string }) => record.id.startsWith("/docs/kv/hidden"))).toBe(false)
})
