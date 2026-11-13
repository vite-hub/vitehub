import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { kv } from "@vite-hub/kv"
import { enableViteHubTestMode } from "@vite-hub/runtime/internal/test-mode-setup"
import { github } from "@vite-hub/source"
import { defineContentPlugin } from "comark-content"
import media from "comark-content/plugins/media"
import { H3 } from "h3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeGitHub } from "../../workspace/test/fake-github.ts"
import { mergeGeneratedSourceNitroConfig, prepareSourceGeneration } from "../../source/src/vite.ts"
import { contentRefTokenParameter, defineContent, defineContentPreset, defineContentPreviewRoutesPlugin, parseContentPreviewPath, registerContentKV, rewriteContentLinks } from "../src/index.ts"

import type { FakeGitHub } from "../../workspace/test/fake-github.ts"
import type { ContentPreviewPath, ContentSourcePreview } from "../src/index.ts"
import type { ContentHub } from "comark-content"

const cleanup: Array<() => Promise<void> | void> = []
let fake: FakeGitHub

const sha = "9c1e4f0a9c1e4f0a9c1e4f0a9c1e4f0a9c1e4f0a"
const draftBranch = "vitehub/content"
const page = (title: string) => `---\ntitle: ${title}\n---\n[Next](/next) [Section](#install) [Home](/) [Site](https://example.com/next) [Protocol](//cdn.example/next)\n`

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-content-routes-"))
  enableViteHubTestMode({ root })
  cleanup.push(async () => {
    await enableViteHubTestMode({ root }).reset()
    Reflect.deleteProperty(globalThis, Symbol.for("vitehub.test"))
    await rm(root, { recursive: true, force: true })
  })
  fake = createFakeGitHub({ owner: "acme", repo: "docs" })
  vi.stubGlobal("fetch", vi.fn(fake.fetch))
  vi.stubEnv("VITEHUB_GITHUB_TOKEN", "token")
  vi.stubEnv("FORGES_GITHUB_TOKEN", "")
  vi.stubEnv("VITEHUB_CONTENT_KEY", "11".repeat(32))
  vi.spyOn(console, "warn").mockImplementation(() => {})
  registerContentKV(kv)
  cleanup.push(() => registerContentKV(undefined))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

describe("parseContentPreviewPath()", () => {
  const cases: Array<[string, Omit<ContentPreviewPath, "route"> & { route: ContentPreviewPath["route"] } | null]> = [
    ["/tree/main", { route: "tree", ref: "main", path: "/", prefix: "/tree/main/-" }],
    ["/tree/main/", { route: "tree", ref: "main", path: "/", prefix: "/tree/main/-" }],
    ["/tree/feat/x/-/docs/kv", { route: "tree", ref: "feat/x", path: "/docs/kv", prefix: "/tree/feat/x/-" }],
    ["/tree/vitehub/content/-/", { route: "tree", ref: "vitehub/content", path: "/", prefix: "/tree/vitehub/content/-" }],
    ["/tree/vitehub/content/-", { route: "tree", ref: "vitehub/content", path: "/", prefix: "/tree/vitehub/content/-" }],
    // The first `-` part ends the ref. A later one belongs to the page path.
    ["/tree/feat/x/-/a/-/b", { route: "tree", ref: "feat/x", path: "/a/-/b", prefix: "/tree/feat/x/-" }],
    ["/tree/feat/x/-/docs/kv/", { route: "tree", ref: "feat/x", path: "/docs/kv/", prefix: "/tree/feat/x/-" }],
    // The page path stays encoded, as the app gets it in production.
    ["/tree/feat/x/-/docs/a%20b", { route: "tree", ref: "feat/x", path: "/docs/a%20b", prefix: "/tree/feat/x/-" }],
    ["/tree/feat%2Dx/-/docs", { route: "tree", ref: "feat-x", path: "/docs", prefix: "/tree/feat-x/-" }],
    [`/blob/${sha}/docs/kv`, { route: "blob", ref: sha, path: "/docs/kv", prefix: `/blob/${sha}` }],
    [`/blob/${sha.toUpperCase()}`, { route: "blob", ref: sha, path: "/", prefix: `/blob/${sha}` }],
    ["/pr/12/docs/kv", { route: "pr", ref: "pr/12", path: "/docs/kv", prefix: "/pr/12" }],
    ["/pr/12", { route: "pr", ref: "pr/12", path: "/", prefix: "/pr/12" }],
    ["/docs/kv", null],
    ["/treehouse/x", null],
    ["/tree/", null],
    ["/tree/-/docs", null],
    // An encoded `/` cannot hide in a ref or a page part.
    ["/tree/feat%2Fx/-/docs", null],
    ["/pr/12/docs%2F..%2Fsecret", null],
    // Traversal: a dot part, plain or encoded, never reaches the app.
    ["/tree/../etc", null],
    ["/tree/main/-/%2e%2e/secret", null],
    ["/tree/main/-/docs/%2E", null],
    ["/pr/12/a%5Cb", null],
    ["/pr/12/a%00b", null],
    ["/pr/12/%E0%A4%A", null],
    ["/tree/.hidden/-/docs", null],
    ["/tree/a..b/-/docs", null],
    ["/tree/feat/x.lock/-/docs", null],
    // Each commit view has one URL shape.
    ["/tree/pr/12/-/docs", null],
    [`/tree/${sha}/-/docs`, null],
    ["/blob/9c1e4f0/docs", null],
    ["/blob/main/docs", null],
    ["/pr/0/docs", null],
    ["/pr/12a/docs", null],
    ["/pr/1234567890/docs", null],
  ]
  it.each(cases)("%s", (path, expected) => {
    expect(parseContentPreviewPath(path)).toEqual(expected)
  })
})

describe("rewriteContentLinks()", () => {
  it("puts internal links of Comark elements under the prefix and keeps other values", () => {
    const date = new Date(0)
    const body = { nodes: [["p", {}, ["a", { href: "/next" }, "Next"], ["a", { href: "#install" }, "Section"], ["a", { href: "//cdn.example/x" }, "CDN"], ["a", { href: "/pr/12/done" }, "Done"]]], date }
    const result = rewriteContentLinks(body, "/pr/12")
    expect(result.nodes).toEqual([["p", {}, ["a", { href: "/pr/12/next" }, "Next"], ["a", { href: "#install" }, "Section"], ["a", { href: "//cdn.example/x" }, "CDN"], ["a", { href: "/pr/12/done" }, "Done"]]])
    expect(result.date).toBe(date)
    // The cached document stays as it was.
    expect(body.nodes[0]![2]).toEqual(["a", { href: "/next" }, "Next"])
    const unchanged = { nodes: [["a", { href: "https://example.com" }, "x"]] }
    expect(rewriteContentLinks(unchanged, "/pr/12")).toBe(unchanged)
  })
})

/** The repository: `main` is published, `feat/open` has an open pull request, and the draft branch is private. */
function repository() {
  fake.commit("main", { "guide.md": page("Guide"), "next.md": page("Next"), "index.md": page("Home") })
  const published = fake.head("main")!
  fake.branch("feat/open", "main")
  const open = fake.commit("feat/open", { "guide.md": page("Guide on feat/open") })
  fake.branch(draftBranch, "main")
  fake.commit(draftBranch, { "guide.md": page("Draft guide") })
  fake.branch("fork-plain", "main")
  const forkSha = fake.commit("fork-plain", { "guide.md": page("Fork guide") })
  return {
    published,
    open,
    forkSha,
    pulls: {
      open: fake.openPull("feat/open", "main", "Same repository"),
      fork: fake.openPull("fork-plain", "main", "From a fork", { fork: "mallory/docs" }),
    },
  }
}

function server(options: { previews?: boolean | { source: string }, sources?: Record<string, ReturnType<typeof github>> } = {}) {
  const drafts = defineContentPreset({ name: "drafts", options: {}, configure: () => ({ privateBranches: [draftBranch] }) })
  const content = defineContent({
    route: "public",
    extends: drafts,
    sources: options.sources ?? { docs: github({ repo: "acme/docs", ref: "main" }) },
    previews: options.previews ?? true,
    seo: { site: "https://docs.example" },
    logger: false,
  })
  cleanup.push(() => content.dispose())
  return content
}

type Server = ReturnType<typeof server>

/** A page route as an app writes it: read the document of the path, and show what `current()` says. */
function app(content: Server, seen: Request[] = []) {
  return async (request: Request): Promise<Response> => {
    seen.push(request)
    const path = new URL(request.url).pathname
    if (path === "/old") return Response.redirect(new URL("/guide?from=old", request.url), 301)
    const document = await content.get(path)
    if (!document) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } })
    const preview: ContentSourcePreview | null = content.sources.current()
    return Response.json({ document, preview }, { headers: { "cache-control": "public, max-age=3600" } })
  }
}

async function serve(content: Server, url: string, init?: RequestInit) {
  const seen: Request[] = []
  const response = await content.sources.route(new Request(url, init), app(content, seen))
  const text = await response.text()
  return { response, text, seen, json: () => JSON.parse(text) as { document: { title?: string }, preview: ContentSourcePreview | null } }
}

function hrefs(text: string): string[] {
  return [...text.matchAll(/"href":"([^"]*)"/g)].map(match => match[1]!)
}

describe("content.sources.route()", () => {
  it("renders the commit of an allowed pull request with its production path", async () => {
    const { open, pulls } = repository()
    const content = server()
    const { response, text, seen, json } = await serve(content, `https://docs.example/pr/${pulls.open}/guide`)
    expect(response.status).toBe(200)
    expect(new URL(seen[0]!.url).pathname).toBe("/guide")
    expect(text).toContain("Guide on feat/open")
    const { preview } = json()
    expect(preview).toMatchObject({ source: "docs", ref: `pr/${pulls.open}`, kind: "pull", sha: open, route: "pr", prefix: `/pr/${pulls.open}`, path: "/guide", url: "https://docs.example/guide" })
    expect(preview?.pull).toMatchObject({ number: pulls.open, head: "feat/open", fork: false })
    // The same server outside the preview reads the published head.
    expect(JSON.stringify(await content.get("/guide"))).not.toContain("feat/open")
    expect(content.sources.current()).toBeNull()
  })

  it("keeps internal links in the rendered Comark tree under the prefix", async () => {
    const { pulls } = repository()
    const content = server()
    const { text } = await serve(content, `https://docs.example/pr/${pulls.open}/guide`)
    expect(hrefs(text)).toEqual([`/pr/${pulls.open}/next`, "#install", `/pr/${pulls.open}/`, "https://example.com/next", "//cdn.example/next"])
    // The production read keeps its links.
    expect(hrefs(JSON.stringify(await content.get("/guide")))).toContain("/next")
  })

  it("sends noindex, a canonical link to production, and a short cache for a pull request", async () => {
    const { pulls } = repository()
    const content = server()
    const { response } = await serve(content, `https://docs.example/pr/${pulls.open}/guide`)
    expect(response.headers.get("x-robots-tag")).toBe("noindex")
    expect(response.headers.get("link")).toBe('<https://docs.example/guide>; rel="canonical"')
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
  })

  it("serves a branch at /tree/<branch>/-/<path>", async () => {
    repository()
    const content = server()
    const { response, text } = await serve(content, "https://docs.example/tree/feat/open/-/guide")
    expect(response.status).toBe(200)
    expect(text).toContain("Guide on feat/open")
    expect(hrefs(text)[0]).toBe("/tree/feat/open/-/next")
    expect(response.headers.get("cache-control")).toBe("public, max-age=60")
  })

  it("caps a published commit at the application lifetime, and a pull request commit short", async () => {
    const { published, open } = repository()
    const content = server()
    const old = await serve(content, `https://docs.example/blob/${published}/guide`)
    expect(old.response.status).toBe(200)
    expect(old.response.headers.get("cache-control")).toBe("public, max-age=3600")
    expect(old.json().preview).toMatchObject({ kind: "commit", sha: published, route: "blob" })
    const head = await serve(content, `https://docs.example/blob/${open}/guide`)
    expect(head.text).toContain("Guide on feat/open")
    expect(head.response.headers.get("cache-control")).toBe("public, max-age=60")
  })

  it("answers a denied ref exactly as a missing ref and an unknown page", async () => {
    const { pulls, forkSha } = repository()
    const content = server()
    const answer = async (path: string) => {
      const { response, text, seen } = await serve(content, `https://docs.example${path}`)
      // The app gets the request as it came, so it answers as for any path it does not know.
      expect(new URL(seen[0]!.url).pathname).toBe(new URL(path, "https://docs.example").pathname)
      return { status: response.status, headers: [...response.headers], text }
    }
    const missing = await answer("/tree/feat/none/-/guide")
    expect(missing.status).toBe(404)
    for (const path of [
      `/tree/${draftBranch}/-/guide`,
      `/pr/${pulls.fork}/guide`,
      `/blob/${forkSha}/guide`,
      "/pr/999/guide",
      // URL parsing resolves an encoded dot part before Content sees it.
      "/tree/main/-/%2e%2e/guide",
      "/pr/1/docs%2F..%2Fguide",
      "/no-such-page",
    ]) expect(await answer(path)).toEqual(missing)
  })

  it("opens a private ref with a signed link, as private, no-store", async () => {
    repository()
    const content = server()
    const { token } = await content.sources.sign(draftBranch, "docs")
    const { response, text } = await serve(content, `https://docs.example/tree/${draftBranch}/-/guide?${contentRefTokenParameter}=${encodeURIComponent(token)}`)
    expect(response.status).toBe(200)
    expect(text).toContain("Draft guide")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  it("keeps a signed link on internal links and redirects of its ref", async () => {
    const { pulls } = repository()
    const content = server()
    const { token } = await content.sources.sign(draftBranch, "docs")
    const query = `${contentRefTokenParameter}=${encodeURIComponent(token)}`
    const prefix = `/tree/${draftBranch}/-`
    const { text } = await serve(content, `https://docs.example${prefix}/guide?${query}`)
    expect(hrefs(text)).toEqual([`${prefix}/next?${query}`, "#install", `${prefix}/?${query}`, "https://example.com/next", "//cdn.example/next"])
    // A reader without a preview cookie follows the link.
    const next = await serve(content, `https://docs.example${prefix}/next?${query}`)
    expect(next.response.status).toBe(200)
    expect(next.text).toContain('"title":"Next"')
    const moved = await serve(content, `https://docs.example${prefix}/old?${query}`)
    expect(moved.response.headers.get("location")).toBe(`${prefix}/guide?from=old&${query}`)
    // A public ref adds no token.
    expect(hrefs((await serve(content, `https://docs.example/pr/${pulls.open}/guide`)).text)[0]).toBe(`/pr/${pulls.open}/next`)
  })

  it("never makes a private application response public", async () => {
    const { published, pulls } = repository()
    const content = server()
    const account = async (url: string, headers: Record<string, string>) => await content.sources.route(new Request(url, { headers: { cookie: "session=1" } }), async () => new Response("secret", { headers }))
    for (const url of [`https://docs.example/pr/${pulls.open}/api/account`, `https://docs.example/blob/${published}/api/account`]) {
      expect((await account(url, { "cache-control": "private, no-store" })).headers.get("cache-control")).toBe("private, no-store")
      expect((await account(url, { "cache-control": "no-cache" })).headers.get("cache-control")).toBe("private, no-cache")
      expect((await account(url, { "set-cookie": "session=2" })).headers.get("cache-control")).toBe("private, no-store")
      expect((await account(url, { "cache-control": "public, max-age=3600" })).headers.get("cache-control")).toMatch(/^public/)
    }
  })

  it("uses the preview cache policy as an upper bound for browser and shared caches", async () => {
    const { published, pulls } = repository()
    const content = server()
    for (const [path, limit] of [[`/pr/${pulls.open}`, 60], [`/blob/${published}`, 31536000]] as const) {
      for (const [own, expected] of [
        [undefined, `public, max-age=${limit}${limit > 60 ? ", immutable" : ""}`],
        ["public, max-age=0, must-revalidate", "public, max-age=0, must-revalidate"],
        ["public, max-age=10, s-maxage=5, must-revalidate", "public, max-age=10, s-maxage=5, must-revalidate"],
        ["public, max-age=99999999, s-maxage=99999999", `public, max-age=${limit}, s-maxage=${limit}`],
        ["private, max-age=99999999", `private, max-age=${limit}`],
        ['public, max-age="10"', "public, max-age=10"],
        ["public, s-maxage=0, must-revalidate", `public, s-maxage=0, must-revalidate, max-age=${limit}`],
      ]) {
        const headers = own ? { "cache-control": own } : undefined
        const response = await content.sources.route(new Request(`https://docs.example${path}/guide`), () => new Response("ok", { headers }))
        expect(response.headers.get("cache-control")).toBe(expected)
      }
    }
    const { token } = await content.sources.sign(draftBranch, "docs")
    const response = await content.sources.route(new Request(`https://docs.example/tree/${draftBranch}/-/guide?${contentRefTokenParameter}=${token}`), () => new Response("ok", { headers: { "cache-control": "private, max-age=3600" } }))
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  it("keeps the host fields of the request when it changes the URL", async () => {
    const { pulls } = repository()
    const content = server()
    const request = new Request(`https://docs.example/pr/${pulls.open}/guide`)
    const waitUntil = vi.fn()
    for (const [key, value] of Object.entries({ runtime: { name: "cloudflare", cloudflare: { env: { KEY: 1 } } }, context: { user: "ada" }, ip: "203.0.113.1", waitUntil })) {
      Object.defineProperty(request, key, { value })
    }
    let seen: Request | undefined
    await content.sources.route(request, async (next) => {
      seen = next
      return new Response("ok")
    })
    expect(new URL(seen!.url).pathname).toBe("/guide")
    expect(seen).toBeInstanceOf(Request)
    expect(seen).toMatchObject({ runtime: { name: "cloudflare" }, context: { user: "ada" }, ip: "203.0.113.1", waitUntil })
    expect(seen!.headers).toBe(request.headers)
  })

  it("reads the commit of the ref from from() and getSource() too", async () => {
    const { pulls } = repository()
    const content = server()
    // SAFETY: The test Source has no generated registry, so the typed `from()` cannot name it.
    const from = content.from as unknown as (name: string) => { get(path: string): Promise<{ data: { title?: unknown } } | null | undefined> }
    const response = await content.sources.route(new Request(`https://docs.example/pr/${pulls.open}/guide`), async () => {
      const direct = await from("docs").get("/guide")
      return Response.json({ get: (await content.get("/guide"))?.data.title, from: direct?.data.title })
    })
    expect(await response.json()).toEqual({ get: "Guide on feat/open", from: "Guide on feat/open" })
    expect((await from("docs").get("/guide"))?.data.title).toBe("Guide")
  })

  it("reads media, instances and custom plugin methods from the preview commit", async () => {
    repository()
    fake.commit("main", { "logo.png": Uint8Array.of(1) })
    fake.commit("feat/open", { "logo.png": Uint8Array.of(2), "preview.png": Uint8Array.of(3) })
    const readTitle = defineContentPlugin(() => ({
      name: "read-title",
      setup(instance) {
        return { readTitle: async () => (await instance.snapshot()).items.find(item => item.path === "/guide") }
      },
    }))
    const content = defineContent({
      route: "public",
      sources: { docs: github({ repo: "acme/docs", ref: "main" }), other: github({ repo: "acme/docs", ref: "main" }) },
      previews: { source: "docs" },
      plugins: [media(), readTitle()],
      logger: false,
    })
    cleanup.push(() => content.dispose())
    const read = async () => {
      const composedMedia: NonNullable<ContentHub["media"]> = content.media
      return [
        await composedMedia.get("docs/logo.png"),
        (await composedMedia.list(["docs"])).map(item => item.path).sort(),
        (await content.instances.find(instance => instance.name === "docs")!.get("/guide"))?.data.title,
        (await content.readTitle())?.data.title,
        (await content.instances.find(instance => instance.name === "other")!.get("/guide"))?.data.title,
      ]
    }
    let result: unknown
    await content.sources.route(new Request("https://docs.example/tree/feat/open/-/guide"), async () => {
      result = await read()
      return new Response("ok")
    })
    expect(result).toEqual([Uint8Array.of(2), ["/logo.png", "/preview.png"], "Guide on feat/open", "Guide on feat/open", "Guide"])
    expect(await read()).toEqual([Uint8Array.of(1), ["/logo.png"], "Guide", "Guide", "Guide"])
  })

  it("keeps a same-site redirect under the prefix", async () => {
    const { pulls } = repository()
    const content = server()
    const { response } = await serve(content, `https://docs.example/pr/${pulls.open}/old`)
    expect(response.status).toBe(301)
    expect(response.headers.get("location")).toBe(`/pr/${pulls.open}/guide?from=old`)
    expect(response.headers.get("x-robots-tag")).toBe("noindex")
  })

  it("passes every request through without previews", async () => {
    const { pulls } = repository()
    const content = server({ previews: false })
    const { response, seen } = await serve(content, `https://docs.example/pr/${pulls.open}/guide`)
    expect(response.status).toBe(404)
    expect(new URL(seen[0]!.url).pathname).toBe(`/pr/${pulls.open}/guide`)
  })

  it("asks for the Source name with more than one github() Source", async () => {
    const { pulls } = repository()
    const sources = { docs: github({ repo: "acme/docs", ref: "main" }), blog: github({ repo: "acme/docs", ref: "main" }) }
    await expect(serve(server({ sources }), `https://docs.example/pr/${pulls.open}/guide`)).rejects.toMatchObject({ code: "CONTENT_R0045" })
    await expect(serve(server({ sources, previews: { source: "nope" } }), `https://docs.example/pr/${pulls.open}/guide`)).rejects.toMatchObject({ code: "CONTENT_R0045" })
    const named = await serve(server({ sources, previews: { source: "docs" } }), `https://docs.example/pr/${pulls.open}/guide`)
    expect(named.json().preview).toMatchObject({ source: "docs" })
  })

  it("rejects an invalid previews option", () => {
    // @ts-expect-error A Source name goes in `{ source }`.
    expect(() => defineContent({ route: "public", sources: { docs: github({ repo: "acme/docs" }) }, previews: "docs", logger: false })).toThrow(expect.objectContaining({ code: "CONTENT_R0045" }))
  })
})

describe("defineContentPreviewRoutesPlugin()", () => {
  it("routes the first captured request while async Nitro plugins are still starting", async () => {
    repository()
    const content = server()
    const projectRoot = await mkdtemp(join(tmpdir(), "content-preview-startup-"))
    cleanup.push(() => rm(projectRoot, { recursive: true, force: true }))
    await mkdir(join(projectRoot, "server"))
    await writeFile(join(projectRoot, "server/content.ts"), 'import { defineContent } from "@vite-hub/content"\nexport default defineContent({ previews: true })')
    const handlers = await prepareSourceGeneration({ projectRoot })
    const config = mergeGeneratedSourceNitroConfig({ plugins: ["async.mjs"] }, handlers)
    const h3 = new H3()
    h3.all("/**", event => app(content)(event.req))
    const nitroApp: { h3: H3, fetch: (request: Request) => Promise<Response>, ready?: Promise<void> } = { h3, fetch: request => Promise.resolve(h3.fetch(request)) }
    let resume!: () => void
    const pending = new Promise<void>((resolve) => { resume = resolve })
    const plugins: Array<(app: typeof nitroApp) => void | Promise<void>> = config.plugins!.map(id => id === "async.mjs" ? () => pending : typeof id === "string" && id.endsWith("/preview-routes.mjs") ? defineContentPreviewRoutesPlugin(content) : () => {})
    // Use Nitro's actual startup gate with the generated plugin order.
    const { initAsyncPlugins } = await import(new URL("./dist/runtime/internal/async-plugins.mjs", import.meta.resolve("nitro/package.json")).href)
    for (const [index, plugin] of plugins.entries()) {
      const result = plugin(nitroApp)
      if (result instanceof Promise) {
        initAsyncPlugins(nitroApp, result, plugins.slice(index + 1))
        break
      }
    }
    const captured = nitroApp.fetch
    const first = captured(new Request("https://docs.example/tree/feat/open/-/guide"))
    resume()
    for (const response of [await first, await captured(new Request("https://docs.example/tree/feat/open/-/guide"))]) {
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("Guide on feat/open")
    }
  })

  it("reaches a server entry that took nitroApp.fetch before the plugin ran", async () => {
    const { pulls } = repository()
    const content = server()
    const h3 = { fetch: async (request: Request) => await app(content)(request) }
    // Nitro's fetch entry calls h3.fetch() on each request.
    const nitroApp = { h3, fetch: (request: Request) => nitroApp.h3.fetch(request) }
    // An earlier async plugin lets the Node server take the entry before this plugin runs.
    const captured = nitroApp.fetch
    defineContentPreviewRoutesPlugin(content)(nitroApp)
    const response = await captured(new Request(`https://docs.example/pr/${pulls.open}/guide`))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Guide on feat/open")
  })


  it("loads Content on the first preview URL only, and serves the page with its production path", async () => {
    const { pulls } = repository()
    const content = server()
    const loader = vi.fn(async () => content)
    const seen: string[] = []
    const nitroApp: { fetch: (request: Request) => Promise<Response> } = {
      fetch: async (request) => {
        seen.push(new URL(request.url).pathname)
        return await app(content)(request)
      },
    }
    defineContentPreviewRoutesPlugin(loader)(nitroApp)
    await nitroApp.fetch(new Request("https://docs.example/guide"))
    await nitroApp.fetch(new Request("https://docs.example/treehouse"))
    expect(loader).not.toHaveBeenCalled()
    const response = await nitroApp.fetch(new Request(`https://docs.example/pr/${pulls.open}/guide`))
    expect(loader).toHaveBeenCalledOnce()
    expect(await response.text()).toContain("Guide on feat/open")
    expect(response.headers.get("x-robots-tag")).toBe("noindex")
    expect(seen).toEqual(["/guide", "/treehouse", "/guide"])
  })
})
