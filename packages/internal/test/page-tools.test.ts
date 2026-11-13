import { brotliCompressSync, gzipSync } from "node:zlib"

import { H3 } from "h3"
import { NodeRequest } from "srvx/node"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { viteHubPageToolsIndexHtml } from "../src/build/page-tools.ts"
import { hasViteHubPageToolsHint, injectPageToolsLoader, installViteHubPageTools, registerViteHubPageTool, respondViteHubPageSession, scriptNonce, viteHubPageSessionHandler } from "../src/runtime/page-tools.ts"
import { viteHubPageToolsInlineScript } from "../src/runtime/page-tools-shared.ts"

import type { IncomingMessage } from "node:http"

import type { ViteHubPageTool } from "../src/runtime/page-tools.ts"

function streamed(chunks: string[], type = "text/html; charset=utf-8"): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { "content-type": type, "content-length": "999" } })
}

/** A tool that allows people whose cookie names them in `people`. */
function tool(id: string, people: string[]): ViteHubPageTool {
  return {
    id,
    label: id.toUpperCase(),
    icon: `i-lucide-${id}`,
    script: `/${id}.js`,
    allowed: async ({ request }) => people.some(person => request.headers.get("cookie")?.includes(`person=${person}`)),
  }
}

const comments = tool("comments", ["ada", "ben"])
const pill = { ...tool("console", ["ada"]), hotkey: "k" }
const loaderTag = "<script type=\"module\" src=\"/_vitehub/page/assets/loader.js?v=20\" data-vitehub-page-tools></script>"
const bootstrap = viteHubPageToolsInlineScript("")

/**
 * Runs the inline bootstrap of a page as a browser would, with this query and `document.cookie`, and returns the
 * scripts that it imports.
 */
function runBootstrap(html: string, search: string, cookie: string): string[] {
  const body = /<script type="module"[^>]*data-vitehub-page-tools>([^<]*)<\/script>/.exec(html)?.[1]
  expect(body).toBeDefined()
  const imported: string[] = []
  // The bootstrap is ViteHub's own generated script. `load` stands in for the dynamic import.
  const run = new Function("location", "document", "load", body!.replace("import(", "load("))
  run({ search }, { cookie }, (script: string) => imported.push(script))
  return imported
}

/** A Nitro 3 app whose fetch returns one HTML page, and counts its calls. */
function nitro3App(html = "<html><body>Page</body></html>") {
  const app = {
    calls: 0,
    fetch(_request: Request): Response {
      app.calls++
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
    },
  }
  return app
}

/** A Nitro 2 app that keeps the handlers of its hooks. */
function nitro2App() {
  const handlers = new Map<string, unknown[]>()
  return {
    handlers,
    hooks: { hook: (name: string, handler: unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]) },
  }
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("hasViteHubPageToolsHint", () => {
  it("reads ?vitehub and the vitehub-tools cookie, never on Console or API paths", () => {
    const hint = (url: string, cookie = "") => hasViteHubPageToolsHint(new Request(url, { headers: { cookie } }))
    expect(hint("http://site.test/pricing?vitehub")).toBe(true)
    expect(hint("http://site.test/pricing?vitehub=comments")).toBe(true)
    expect(hint("http://site.test/", "a=1; vitehub-tools=1")).toBe(true)
    expect(hint("http://site.test/")).toBe(false)
    expect(hint("http://site.test/", "vitehub-tools=0")).toBe(false)
    // A new Auth session that the session route has not checked yet.
    expect(hint("http://site.test/", "vitehub_session=1")).toBe(true)
    expect(hint("http://site.test/", "vitehub_session=1; vitehub-tools=0")).toBe(false)
    // The old Comments hints are gone.
    expect(hint("http://site.test/?comments", "vitehub-comments=1")).toBe(false)
    expect(hint("http://site.test/_vitehub/content?vitehub", "vitehub-tools=1")).toBe(false)
    expect(hint("http://site.test/api/x?vitehub", "vitehub-tools=1")).toBe(false)
  })
})

describe("injectPageToolsLoader", () => {
  it("adds one loader tag before </body>, also when the tag spans two chunks", async () => {
    const response = injectPageToolsLoader(streamed(["<html><body><h1>Hi</h1></bo", "dy></html>"]))
    expect(await response.text()).toBe(`<html><body><h1>Hi</h1>${loaderTag}</body></html>`)
    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  it.each([
    { encoding: "gzip", compress: gzipSync },
    { encoding: "br", compress: brotliCompressSync },
  ])("leaves $encoding HTML and its headers unchanged", async ({ encoding, compress }) => {
    const bytes = new Uint8Array(compress("<html><body>Page</body></html>"))
    const response = new Response(bytes, { headers: {
      "content-type": "text/html; charset=utf-8",
      "content-encoding": encoding,
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=3600",
    } })
    const headers = [...response.headers]
    const injected = injectPageToolsLoader(response)
    expect(injected).toBe(response)
    expect([...injected.headers]).toEqual(headers)
    expect(new Uint8Array(await injected.arrayBuffer())).toEqual(bytes)
  })

  it("still injects HTML with identity content encoding", async () => {
    const response = streamed(["<body>Page</body>"])
    response.headers.set("content-encoding", "identity")
    expect(await injectPageToolsLoader(response).text()).toBe(`<body>Page${loaderTag}</body>`)
  })

  it("preserves astral characters at the retained tail boundary", async () => {
    const response = injectPageToolsLoader(streamed(["<body>😀1234567", "</body>"]))
    expect(await response.text()).toBe(`<body>😀1234567${loaderTag}</body>`)
  })

  it("gives the loader the nonce of the page's Content Security Policy, which 'strict-dynamic' needs", async () => {
    const policy = "default-src 'self'; script-src 'self' 'strict-dynamic' 'nonce-a1B2+c/3=='; style-src 'self' 'nonce-style'"
    expect(scriptNonce(new Headers({ "content-security-policy": policy }))).toBe("a1B2+c/3==")
    expect(scriptNonce(new Headers({ "content-security-policy": "default-src 'self' 'nonce-xyz'" }))).toBe("xyz")
    expect(scriptNonce(new Headers({ "content-security-policy": "script-src-elem 'nonce-elem'; script-src 'nonce-other'" }))).toBe("elem")
    expect(scriptNonce(new Headers())).toBeUndefined()
    const page = new Response("<body></body>", { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": policy } })
    expect(await injectPageToolsLoader(page).text()).toBe("<body><script type=\"module\" src=\"/_vitehub/page/assets/loader.js?v=20\" nonce=\"a1B2+c/3==\" data-vitehub-page-tools></script></body>")
  })

  it.each([
    ["script-src 'self'", ""],
    ["script-src 'nonce-n1' 'strict-dynamic'", " nonce=\"n1\""],
    ["script-src-elem 'nonce-n2'; script-src 'none'", " nonce=\"n2\""],
  ])("replaces the SPA inline check with one external loader under %s", async (policy, nonce) => {
    const page = viteHubPageToolsIndexHtml("<body>Page</body>", "/portal/")!
    // Exercise splits in both tags and in the inline script, including a chunk per character.
    for (const chunks of [[page], [...page]]) {
      const response = streamed(chunks)
      response.headers.set("content-security-policy", policy)
      const html = await injectPageToolsLoader(response, "/portal").text()
      expect(html).toBe(`<body>Page<script type="module" src="/portal/_vitehub/page/assets/loader.js?v=20"${nonce} data-vitehub-page-tools></script></body>`)
    }
    // An external loader already in the response remains the sole loader.
    const external = streamed([loaderTag])
    external.headers.set("content-security-policy", policy)
    expect(await injectPageToolsLoader(external).text()).toBe(loaderTag)
  })

  it.each(["script-src 'self'", "default-src 'self'"])("replaces the generated check under meta CSP %s without a response CSP header", async (policy) => {
    const head = `<head><meta http-equiv="Content-Security-Policy" content="${policy}"></head>`
    const page = viteHubPageToolsIndexHtml(`${head}<body>Page</body>`, "/portal/")!
    for (const chunks of [[page], [...page]]) {
      const response = streamed(chunks)
      expect(response.headers.has("content-security-policy")).toBe(false)
      expect(await injectPageToolsLoader(response, "/portal").text()).toBe(`${head}<body>Page${loaderTag.replace('src="/_vitehub', 'src="/portal/_vitehub')}</body>`)
    }
  })

  it("appends the loader to HTML without a body tag, and leaves other responses alone", async () => {
    expect(await injectPageToolsLoader(streamed(["<h1>Hi</h1>"])).text()).toBe(`<h1>Hi</h1>${loaderTag}`)
    const json = streamed(["{}"], "application/json")
    expect(injectPageToolsLoader(json)).toBe(json)
    const missing = new Response("<body></body>", { headers: { "content-type": "text/html; charset=utf-8" }, status: 404 })
    expect(injectPageToolsLoader(missing)).toBe(missing)
  })

  it.each([
    ["comment", "<!-- ", " -->"],
    ["textarea", "<textarea>", "</textarea>"],
    ["title", "<title>", "</title>"],
    ["style", "<style>", "</style>"],
    ["script example", '<script>const example = "', '"</script>'],
    ["attribute", '<div title=\'', "'></div>"],
    ["nested template", "<template><template>", "</template></template>"],
  ])("preserves an inert generated opening tag in %s", async (name, before, after) => {
    const opening = '<script type="module" data-vitehub-page-tools>'
    const check = viteHubPageToolsIndexHtml("", "/portal/")!
    // An unclosed script consumes the rest of a template. Other inert contexts can quote just the opening tag.
    const snippets = name === "nested template" ? [check] : [opening, check]
    for (const snippet of snippets) {
      const content = `<body>${before}${snippet}${after}<p>Unrelated tail 🐸</p>`
      const page = `${content}</body>`
      for (const chunks of [[page], [...page]]) {
        expect(await injectPageToolsLoader(streamed(chunks)).text()).toBe(`${content}${loaderTag}</body>`)
      }
    }
  })

  it("ignores inert markers before replacing the active SPA check at every split", async () => {
    const check = viteHubPageToolsIndexHtml("", "/portal/")!
    const before = `<body><!-- ${check} --><template>${check}</template><textarea>${check}</textarea>`
    const page = `${before}${check}</body>`
    const external = loaderTag.replace('src="/_vitehub', 'src="/portal/_vitehub')
    for (let split = 0; split <= page.length; split++) {
      expect(await injectPageToolsLoader(streamed([page.slice(0, split), page.slice(split)]), "/portal").text()).toBe(`${before}${external}</body>`)
    }
  })

  it("retains an unfinished marked script instead of discarding the response tail", async () => {
    const page = '<body><script type="module" data-vitehub-page-tools>unfinished 🐸'
    expect(await injectPageToolsLoader(streamed([...page])).text()).toBe(page)
  })

  it("preserves a marked inline script whose content was not generated by ViteHub", async () => {
    const page = '<body><script type="module" data-vitehub-page-tools>console.log("keep")</script></body>'
    expect(await injectPageToolsLoader(streamed([...page])).text()).toBe(page)
  })
})

describe("installViteHubPageTools on Nitro 3", () => {
  it("returns a response that is not an HTML page without reading its body or the request URL", async () => {
    const reads = { body: 0, url: 0 }
    class CountedResponse extends Response {
      override get body() {
        reads.body++
        return super.body
      }
    }
    class CountedRequest extends Request {
      override get url() {
        reads.url++
        return super.url
      }
    }
    for (const response of [Response.json({ ok: true }), new Response("hello"), new Response("<body>Gone</body>", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } })]) {
      const original = new CountedResponse(response.body, response)
      const app = { fetch: (_request: Request) => original }
      registerViteHubPageTool(app, comments)
      installViteHubPageTools(app)
      expect(await app.fetch(new CountedRequest("http://site.test/"))).toBe(original)
    }
    expect(reads).toEqual({ body: 0, url: 0 })
  })

  it.each(["", "?vitehub"])("uses a meta-only CSP nonce for a new page tools script with %s", async (search) => {
    const head = '<head><meta content="script-src \'nonce-meta-nonce\' \'strict-dynamic\'" HTTP-EQUIV="Content-Security-Policy"></head>'
    const html = `${head}<body>Page</body>`
    for (const chunks of [[html], [...html]]) {
      const app = { fetch: (_request: Request) => streamed(chunks) }
      registerViteHubPageTool(app, comments)
      installViteHubPageTools(app)
      const page = await app.fetch(new Request(`http://site.test/${search}`))
      const tag = search ? loaderTag.replace(" data-vitehub", ' nonce="meta-nonce" data-vitehub') : viteHubPageToolsInlineScript("", "meta-nonce")
      expect(await page.text()).toBe(`${head}<body>Page${tag}</body>`)
    }
  })

  it.each(["", "?vitehub"])("preserves byte HTML without an HTTP charset for requests with %s", async (search) => {
    const bytes = Buffer.from('<meta charset="windows-1252"><body>café</body>', "latin1")
    const original = new Response(bytes, { headers: { "content-type": "text/html", etag: "old", "cache-control": "public, max-age=60" } })
    const app = { fetch: (_request: Request) => original }
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const page = await app.fetch(new Request(`http://site.test/${search}`))
    expect(page).toBe(original)
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(new Uint8Array(bytes))
    expect([...page.headers]).toEqual([...original.headers])
  })

  it.each(["", "?vitehub"])("preserves a generated bootstrap's meta-CSP nonce for requests with %s", async (search) => {
    const head = '<head><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-meta-nonce\' \'strict-dynamic\'"></head>'
    const html = `${head}<body>Page${viteHubPageToolsInlineScript("/portal", "meta-nonce")}</body>`
    for (const chunks of [[html], [...html]]) {
      const app = { fetch: (_request: Request) => streamed(chunks) }
      registerViteHubPageTool(app, comments)
      installViteHubPageTools(app, { base: "/portal" })
      const page = await app.fetch(new Request(`http://site.test/portal/${search}`))
      const tag = search ? loaderTag.replace('src="/_vitehub', 'src="/portal/_vitehub').replace(" data-vitehub", ' nonce="meta-nonce" data-vitehub') : viteHubPageToolsInlineScript("/portal", "meta-nonce")
      expect(await page.text()).toBe(`${head}<body>Page${tag}</body>`)
    }
  })

  it.each(["", "?vitehub"])("preserves legacy-encoded HTML for requests with %s", async (search) => {
    const bytes = Buffer.from("<body>café</body>", "latin1")
    const original = new Response(bytes, { headers: { "content-type": "text/html; charset=iso-8859-1", etag: "old", "cache-control": "public, max-age=60" } })
    const app = { fetch: (_request: Request) => original }
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const page = await app.fetch(new Request(`http://site.test/${search}`))
    expect(page).toBe(original)
    expect(new Uint8Array(await page.arrayBuffer())).toEqual(new Uint8Array(bytes))
    expect([...page.headers]).toEqual([...original.headers])
  })

  it.each(["", "?vitehub"])("refreshes a prerendered bootstrap's nonce for requests with %s", async (search) => {
    const html = `<body>Page${viteHubPageToolsInlineScript("/portal", "build-nonce")}</body>`
    const app = { fetch: (_request: Request) => {
      const page = streamed([...html])
      page.headers.set("content-security-policy", "script-src 'nonce-request-nonce' 'strict-dynamic'")
      return page
    } }
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app, { base: "/portal" })
    const page = await app.fetch(new Request(`http://site.test/portal/${search}`))
    const tag = search ? loaderTag.replace('src="/_vitehub', 'src="/portal/_vitehub').replace(" data-vitehub", ' nonce="request-nonce" data-vitehub') : viteHubPageToolsInlineScript("/portal", "request-nonce")
    expect(await page.text()).toBe(`<body>Page${tag}</body>`)
  })

  it.each(["", "?vitehub"])("does not validate transformed HTML against an upstream representation with %s", async (search) => {
    const app = { fetch: (request: Request) => {
      if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) return new Response(null, { status: 304 })
      return new Response("<body>Page</body>", { headers: { "content-type": "text/html; charset=utf-8", etag: '"page"', "last-modified": "Mon, 02 Nov 2026 12:00:00 GMT", "content-length": "17", "cache-control": "public, max-age=60" } })
    } }
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const request = new Request(`http://site.test/${search}`, { headers: { accept: "text/html;q=0.5,application/xhtml+xml,*/*;q=0.8", "if-none-match": '"page"', "if-modified-since": "Mon, 02 Nov 2026 12:00:00 GMT" } })
    const page = await app.fetch(request)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe(`<body>Page${search ? loaderTag : bootstrap}</body>`)
    expect(page.headers.has("etag")).toBe(false)
    expect(page.headers.has("last-modified")).toBe(false)
    expect(page.headers.has("content-length")).toBe(false)
    expect(page.headers.get("cache-control")).toBe(search ? "private, no-store" : "public, max-age=60")
    expect(request.headers.has("if-none-match") || request.headers.has("if-modified-since")).toBe(false)
  })

  it.each([undefined, "*/*", "text/css,*/*;q=0.1", "application/rss+xml", "application/rss+xml, text/html;q=0", "text/html; Q=0.000, */*;q=1"])("keeps conditional requests for non-HTML resources on ordinary paths with Accept %s", async (accept) => {
    const headers = new Headers({ "if-none-match": '"resource"', "if-modified-since": "Mon, 02 Nov 2026 12:00:00 GMT" })
    if (accept) headers.set("accept", accept)
    const original = new Response(null, { status: 304, headers: { "content-type": "application/rss+xml", etag: '"resource"', "cache-control": "public, max-age=60" } })
    const app = { fetch: (request: Request) => {
      expect([...request.headers]).toEqual([...headers])
      return original
    } }
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    expect(await app.fetch(new Request("http://site.test/feed", { headers }))).toBe(original)
  })

  /** A Nitro 3 app that answers 304 to a request with validators, and keeps the requests that it gets. */
  function conditionalApp() {
    const app = {
      requests: [] as Request[],
      fetch(request: Request): Response {
        app.requests.push(request)
        if (request.headers.has("if-none-match") || request.headers.has("if-modified-since")) return new Response(null, { status: 304 })
        return new Response("<body>Page</body>", { headers: { "content-type": "text/html; charset=utf-8", etag: '"page"' } })
      },
    }
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    return app
  }

  it("removes validators from the Node.js request of srvx and passes that same request on", async () => {
    const headers = { host: "site.test", accept: "text/html", "if-none-match": '"page"', "if-modified-since": "Mon, 02 Nov 2026 12:00:00 GMT" }
    // SAFETY: srvx reads only these fields of a Node.js request that has no body.
    const request = new NodeRequest({ req: { method: "GET", url: "/guide/", headers, rawHeaders: Object.entries(headers).flat() } as unknown as IncomingMessage })
    const app = conditionalApp()
    const page = await app.fetch(request)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe(`<body>Page${bootstrap}</body>`)
    expect(app.requests).toHaveLength(1)
    expect(app.requests[0]).toBe(request)
    // Nitro's Node-format routes read the Node.js headers, which srvx stores apart from the Fetch headers.
    expect(headers).not.toHaveProperty("if-none-match")
    expect(headers).not.toHaveProperty("if-modified-since")
  })

  it("copies a request whose headers cannot change, as on Cloudflare Workers", async () => {
    const request = new Request("http://site.test/guide/", { headers: { accept: "text/html", "if-none-match": '"page"' } })
    vi.spyOn(request.headers, "delete").mockImplementation(() => {
      throw new TypeError("Can't modify immutable headers.")
    })
    const app = conditionalApp()
    const page = await app.fetch(request)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe(`<body>Page${bootstrap}</body>`)
    expect(app.requests[0]).not.toBe(request)
    expect(app.requests[0]!.url).toBe(request.url)
    expect(request.headers.get("if-none-match")).toBe('"page"')
  })

  it.each(["/api/page", "/_vitehub", "/outside"])("keeps conditional requests outside the page paths on %s", async (path) => {
    const app = { fetch: (request: Request) => new Response(null, { status: request.headers.has("if-none-match") ? 304 : 200 }) }
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app, { base: path === "/outside" ? "/portal" : "" })
    expect((await app.fetch(new Request(`http://site.test${path}`, { headers: { "if-none-match": '"page"' } }))).status).toBe(304)
  })

  it("adds exactly one loader tag for any number of tools, with one fetch wrapper", async () => {
    const app = nitro3App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    registerViteHubPageTool(app, pill)
    installViteHubPageTools(app)
    const response = await app.fetch(new Request("http://site.test/?vitehub"))
    expect(await response.text()).toBe(`<html><body>Page${loaderTag}</body></html>`)
    expect(app.calls).toBe(1)
    const cookie = await app.fetch(new Request("http://site.test/guide", { headers: { cookie: "vitehub-tools=1" } }))
    expect(await cookie.text()).toBe(`<html><body>Page${loaderTag}</body></html>`)
  })

  it("wraps fetch once when it is installed twice", async () => {
    const app = nitro3App()
    installViteHubPageTools(app)
    const wrapped = app.fetch
    installViteHubPageTools(app)
    expect(app.fetch).toBe(wrapped)
    registerViteHubPageTool(app, comments)
    expect(await (await app.fetch(new Request("http://site.test/?vitehub"))).text()).toBe(`<html><body>Page${loaderTag}</body></html>`)
  })

  it("adds nothing without a registered tool, and the bootstrap without the hint, and keeps the page cacheable", async () => {
    const app = nitro3App()
    installViteHubPageTools(app)
    const none = await app.fetch(new Request("http://site.test/?vitehub"))
    expect(await none.text()).toBe("<html><body>Page</body></html>")
    registerViteHubPageTool(app, comments)
    const response = await app.fetch(new Request("http://site.test/"))
    expect(await response.text()).toBe(`<html><body>Page${bootstrap}</body></html>`)
    expect(response.headers.get("cache-control")).toBeNull()
  })

  it("adds the bootstrap to prerendered pages, once, and it loads the loader only with the hint", async () => {
    const spa = nitro3App(`<html><body>App${viteHubPageToolsInlineScript("/docs/")}</body></html>`)
    registerViteHubPageTool(spa, comments)
    installViteHubPageTools(spa, { base: "/docs/" })
    const page = await spa.fetch(new Request("http://site.test/docs/guide", { headers: { "x-nitro-prerender": "/docs/guide" } }))
    const html = await page.text()
    expect(html).toBe(`<html><body>App${viteHubPageToolsInlineScript("/docs/")}</body></html>`)
    expect(runBootstrap(html, "", "")).toEqual([])
    expect(runBootstrap(html, "", "theme=dark; vitehub-tools=0")).toEqual([])
    expect(runBootstrap(html, "?vitehub", "")).toEqual(["/docs/_vitehub/page/assets/loader.js?v=20"])
    expect(runBootstrap(html, "", "vitehub-tools=1")).toEqual(["/docs/_vitehub/page/assets/loader.js?v=20"])
    // Right after sign-in, Auth has set its marker and cleared the hint: the loader asks the session route once.
    expect(runBootstrap(html, "", "vitehub_session=1")).toEqual(["/docs/_vitehub/page/assets/loader.js?v=20"])
    expect(runBootstrap(html, "", "vitehub_session=1; vitehub-tools=0")).toEqual([])
  })

  it("gives the bootstrap the nonce of the page's Content Security Policy", async () => {
    const app = { fetch: () => new Response("<body>Page</body>", { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'strict-dynamic' 'nonce-n2'" } }) }
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    expect(await (await app.fetch(new Request("http://site.test/"))).text()).toBe(`<body>Page${viteHubPageToolsInlineScript("", "n2")}</body>`)
  })

  it("answers the session for the Request that the Nitro 3 app bound", async () => {
    const app = nitro3App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const request = new Request("http://site.test/_vitehub/page/session", { headers: { cookie: "person=ada" } })
    await app.fetch(request)
    const response = await viteHubPageSessionHandler.fetch(request)
    expect(response.status).toBe(200)
    expect((await response.json()).tools.map((tool: { id: string }) => tool.id)).toEqual(["comments"])
  })

  it("never adds the loader to Console or API routes", async () => {
    const app = nitro3App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    for (const path of ["/_vitehub/content", "/api/x"]) {
      expect(await (await app.fetch(new Request(`http://site.test${path}?vitehub`))).text()).toBe("<html><body>Page</body></html>")
    }
  })
})

describe("installViteHubPageTools on Nitro 2", () => {
  it.each(["string", "bytes", "Response"])("uses a meta-only CSP nonce for a new page tools script in %s HTML", async (format) => {
    for (const search of ["", "?vitehub"]) {
      const app = nitro2App()
      registerViteHubPageTool(app, comments)
      installViteHubPageTools(app)
      const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
      const head = '<head><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-meta-nonce\' \'strict-dynamic\'"></head>'
      const html = `${head}<body>Page</body>`
      const headers = new Map([["content-type", "text/html; charset=utf-8"]])
      const response = { body: (format === "Response" ? new Response(html, { headers: Object.fromEntries(headers) }) : format === "bytes" ? new TextEncoder().encode(html) : html) as unknown }
      await respond({ node: { req: { url: `/${search}`, headers: {} }, res: { getHeader: (name: string) => headers.get(name) } } }, response)
      const tag = search ? loaderTag.replace(" data-vitehub", ' nonce="meta-nonce" data-vitehub') : viteHubPageToolsInlineScript("", "meta-nonce")
      expect(response.body instanceof Response ? await response.body.text() : response.body).toBe(`${head}<body>Page${tag}</body>`)
    }
  })

  it.each(["string", "bytes", "Response"])("preserves the meta-CSP nonce when replacing a generated bootstrap in %s HTML", async (format) => {
    for (const search of ["", "?vitehub"]) {
      const app = nitro2App()
      registerViteHubPageTool(app, comments)
      installViteHubPageTools(app)
      const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
      const head = '<head><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-meta-nonce\' \'strict-dynamic\'"></head>'
      const html = `${head}<body>Page${viteHubPageToolsInlineScript("", "meta-nonce")}</body>`
      const headers = new Map([["content-type", "text/html; charset=utf-8"]])
      const response = { body: (format === "Response" ? new Response(html, { headers: Object.fromEntries(headers) }) : format === "bytes" ? new TextEncoder().encode(html) : html) as unknown }
      await respond({ node: { req: { url: `/${search}`, headers: {} }, res: { getHeader: (name: string) => headers.get(name) } } }, response)
      const tag = search ? loaderTag.replace(" data-vitehub", ' nonce="meta-nonce" data-vitehub') : viteHubPageToolsInlineScript("", "meta-nonce")
      expect(response.body instanceof Response ? await response.body.text() : response.body).toBe(`${head}<body>Page${tag}</body>`)
    }
  })

  it.each([undefined, "*/*", "application/rss+xml", "application/rss+xml, text/html;q=0", "text/html; Q=0.000, */*;q=1"])("keeps resource validators on ordinary paths with Accept %s", async (accept) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const onRequest = app.handlers.get("request")![0] as (event: object) => void
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
    const headers: Record<string, string> = { "if-none-match": '"feed"', "if-modified-since": "Mon, 02 Nov 2026 12:00:00 GMT" }
    if (accept) headers.accept = accept
    const event = { web: { request: new Request("http://site.test/feed", { headers }) }, node: { req: { url: "/feed", headers: { ...headers } } } }
    onRequest(event)
    expect(Object.fromEntries(event.web.request.headers)).toEqual(headers)
    expect(event.node.req.headers).toEqual(headers)
    const original = new Response(null, { status: 304, headers: { "content-type": "application/rss+xml", etag: '"feed"' } })
    const response = { body: original }
    await respond(event, response)
    expect(response.body).toBe(original)
  })

  it.each([undefined, "script-src 'nonce-response'"])("uses Node's CSP only when the returned Response has none (%s)", async (responsePolicy) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    registerViteHubPageTool(app, pill)
    installViteHubPageTools(app)
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => void
    const headers = new Headers({ "content-type": "text/html; charset=utf-8" })
    if (responsePolicy) headers.set("content-security-policy", responsePolicy)
    const response = { body: new Response("<body>Page</body>", { headers }) }
    respond({ node: {
      req: { url: "/?vitehub", headers: {} },
      res: { getHeader: (name: string) => name === "content-security-policy" ? "script-src 'strict-dynamic' 'nonce-node'" : undefined },
    } }, response)
    const nonce = responsePolicy ? "response" : "node"
    const tags = loaderTag.replace(" data-vitehub", ` nonce="${nonce}" data-vitehub`)
    expect(await response.body.text()).toBe(`<body>Page${tags}</body>`)
    expect(response.body.headers.get("cache-control")).toBe("private, no-store")
  })

  it("isolates both hooks per app while sharing registrations and installation across bundled owners", async () => {
    const appA = nitro2App()
    const appB = nitro2App()
    registerViteHubPageTool(appA, comments)
    installViteHubPageTools(appA)
    installViteHubPageTools(appB)
    vi.resetModules()
    const otherOwner = await import("../src/runtime/page-tools.ts")
    otherOwner.registerViteHubPageTool(appB, { ...comments, script: "/app-b.js" })
    otherOwner.registerViteHubPageTool(appB, pill)
    otherOwner.installViteHubPageTools(appB)
    otherOwner.installViteHubPageTools(appA)
    const event = { web: { request: new Request("http://site.test/?vitehub") } }
    for (const [app, tags] of [[appA, loaderTag], [appB, loaderTag]] as const) {
      expect(app.handlers.get("render:html")).toHaveLength(1)
      expect(app.handlers.get("beforeResponse")).toHaveLength(1)
      const render = app.handlers.get("render:html")![0] as (html: { bodyAppend: string[] }, context: unknown) => void
      const html = { bodyAppend: [] as string[] }
      render(html, { event })
      expect(html.bodyAppend).toEqual([tags])
      const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => void
      const response = { body: new Response("<body>Page</body>", { headers: { "content-type": "text/html; charset=utf-8" } }) }
      respond(event, response)
      expect(await response.body.text()).toBe(`<body>Page${tags}</body>`)
    }
  })

  it("adds the loader in Nuxt's render:html hook, and keeps that page out of shared caches", () => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    registerViteHubPageTool(app, pill)
    installViteHubPageTools(app)
    installViteHubPageTools(app)
    expect(app.handlers.get("render:html")).toHaveLength(1)
    expect(app.handlers.get("beforeResponse")).toHaveLength(1)
    const render = app.handlers.get("render:html")![0] as (html: { bodyAppend: string[] }, context: unknown) => void
    const headers: Record<string, string> = {}
    const page = (url: string) => {
      const html = { bodyAppend: [] as string[] }
      render(html, { event: { node: { req: { url, headers: {} }, res: { setHeader: (name: string, value: string) => { headers[name] = value } } } } })
      return html.bodyAppend
    }
    // Every other page, such as a prerendered one, gets the bootstrap and stays cacheable.
    expect(page("/")).toEqual([bootstrap])
    expect(headers).toEqual({})
    expect(page("/_vitehub/content")).toEqual([])
    expect(page("/?vitehub")).toEqual([loaderTag])
    expect(headers).toEqual({ "cache-control": "private, no-store" })
    const html = { bodyAppend: [] as string[] }
    render(html, { event: { node: { req: { url: "/?vitehub", headers: {} }, res: { setHeader() {}, getHeader: () => "script-src 'self' 'strict-dynamic' 'nonce-n1'" } } } })
    expect(html.bodyAppend[0]).toContain("nonce=\"n1\"")
    render(html, { event: { node: { req: { url: "/", headers: {} }, res: { setHeader() {}, getHeader: () => "script-src 'self' 'strict-dynamic' 'nonce-n1'" } } } })
    expect(html.bodyAppend[1]).toBe(viteHubPageToolsInlineScript("", "n1"))
  })

  it.each(["", "vitehub-tools=1"])("injects buffered HTML once and clears stale cache metadata with cookie '%s'", async (cookie) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
    const headers = new Map<string, string>([["content-type", "text/html; charset=utf-8"], ["content-length", "26"], ["etag", "old"], ["last-modified", "Mon, 02 Nov 2026 12:00:00 GMT"], ["cache-control", "public, max-age=60"]])
    const event = { node: {
      req: { url: "/guide/", headers: { cookie } },
      res: { getHeader: (key: string) => headers.get(key), setHeader: (key: string, value: string) => headers.set(key, value), removeHeader: (key: string) => headers.delete(key) },
    } }
    const response = { body: new TextEncoder().encode("<body>Page</body>") as unknown }
    await respond(event, response)
    expect(response.body).toBe(`<body>Page${cookie ? loaderTag : bootstrap}</body>`)
    expect(headers.has("content-length")).toBe(false)
    expect(headers.has("etag")).toBe(false)
    expect(headers.has("last-modified")).toBe(false)
    expect(headers.get("cache-control")).toBe(cookie ? "private, no-store" : "public, max-age=60")
    await respond(event, response)
    expect(response.body).toBe(`<body>Page${cookie ? loaderTag : bootstrap}</body>`)
    headers.set("content-type", "image/png")
    const binary = { body: new Uint8Array([1, 2, 3]) }
    await respond(event, binary)
    expect(binary.body).toEqual(new Uint8Array([1, 2, 3]))
  })

  it.each(["text/html", "text/html; charset=iso-8859-1", 'text/html; charset="ISO-8859-1"', "text/html; charset=windows-1252"])("preserves byte HTML and headers for %s", async (type) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
    const body = Buffer.from('<meta charset="windows-1252"><body>café</body>', "latin1")
    const headers = new Map([["content-type", type], ["content-length", String(body.length)], ["etag", "old"], ["cache-control", "public, max-age=60"]])
    const originalHeaders = new Map(headers)
    const response = { body }
    await respond({ node: {
      req: { url: "/?vitehub", headers: {} },
      res: { getHeader: (key: string) => headers.get(key), setHeader: (key: string, value: string) => headers.set(key, value), removeHeader: (key: string) => headers.delete(key) },
    } }, response)
    expect(response.body).toBe(body)
    expect(headers).toEqual(originalHeaders)
  })

  it.each(["text/html; charset=utf-8", 'text/html; Charset="UTF-8"', "text/html; charset=utf8"])("injects byte HTML with non-ASCII text for %s", async (type) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
    const headers = new Map([["content-type", type]])
    const response = { body: new TextEncoder().encode("<body>café 🐸</body>") as unknown }
    await respond({ node: {
      req: { url: "/?vitehub", headers: {} },
      res: { getHeader: (key: string) => headers.get(key), setHeader: (key: string, value: string) => headers.set(key, value) },
    } }, response)
    expect(response.body).toBe(`<body>café 🐸${loaderTag}</body>`)
    expect(headers.get("content-type")).toBe(type)
    expect(headers.get("cache-control")).toBe("private, no-store")
  })

  it.each(["string", "bytes"])("replaces the generated SPA check in buffered %s HTML under CSP", async (format) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app, { base: "/portal/" })
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
    const headers = new Map([["content-type", "text/html; charset=utf-8"], ["content-security-policy", "script-src 'nonce-n1' 'strict-dynamic'"], ["etag", "old"]])
    const html = viteHubPageToolsIndexHtml("<body>Page</body>", "/portal/")!
    const response = { body: (format === "string" ? html : new TextEncoder().encode(html)) as unknown }
    const event = { node: {
      req: { url: "/portal/guide/?vitehub", headers: {} },
      res: { statusCode: 200, getHeader: (key: string) => headers.get(key), setHeader: (key: string, value: string) => headers.set(key, value), removeHeader: (key: string) => headers.delete(key) },
    } }
    await respond(event, response)
    const expected = '<body>Page<script type="module" src="/portal/_vitehub/page/assets/loader.js?v=20" nonce="n1" data-vitehub-page-tools></script></body>'
    expect(response.body).toBe(expected)
    expect(headers.has("etag")).toBe(false)
    expect(headers.get("cache-control")).toBe("private, no-store")
    await respond(event, response)
    expect(response.body).toBe(expected)
  })

  it.each(["string", "bytes"])("preserves inert markup while injecting buffered %s HTML", async (format) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
    const check = viteHubPageToolsIndexHtml("", "/portal/")!
    const content = `<body><!-- ${check} --><template>${check}</template><textarea>${check}</textarea><p>Tail 🐸</p>`
    const headers = new Map([["content-type", "text/html; charset=utf-8"]])
    const event = { node: {
      req: { url: "/?vitehub", headers: {} },
      res: { getHeader: (key: string) => headers.get(key), setHeader: (key: string, value: string) => headers.set(key, value) },
    } }
    for (const html of [`${content}</body>`, `${content}${check}</body>`]) {
      const response = { body: (format === "string" ? html : new TextEncoder().encode(html)) as unknown }
      await respond(event, response)
      expect(response.body).toBe(`${content}${loaderTag}</body>`)
    }
  })

  it.each([201, 204, 206, 302, 304, 404, 500])("preserves buffered non-200 HTML and headers for status %s", async (statusCode) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
    for (const body of ["<body>Error</body>", new TextEncoder().encode("<body>Error</body>")]) {
      const headers = new Map([["content-type", "text/html"], ["content-length", "18"], ["etag", "old"], ["cache-control", "public, max-age=60"]])
      const originalHeaders = new Map(headers)
      const response = { body }
      await respond({ node: {
        req: { url: "/?vitehub", headers: {} },
        res: { statusCode, getHeader: (key: string) => headers.get(key), setHeader: (key: string, value: string) => headers.set(key, value), removeHeader: (key: string) => headers.delete(key) },
      } }, response)
      expect(response.body).toBe(body)
      expect(headers).toEqual(originalHeaders)
    }
  })

  it("adds the loader to a page that a route returns as a Response, such as a prerendered file", async () => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => void
    const send = (url: string, body: unknown, cookie = "") => {
      const response = { body }
      respond({ node: { req: { url, headers: { cookie } } } }, response)
      return response.body
    }
    const file = () => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } })
    const plain = send("/guide/", file())
    expect(plain).toBeInstanceOf(Response)
    if (!(plain instanceof Response)) return
    expect(await plain.text()).toBe(`<html><body>Page${bootstrap}</body></html>`)
    expect(plain.headers.get("cache-control")).toBe("public, max-age=3600")
    expect(send("/guide/", "<html></html>", "vitehub-tools=1")).toBe("<html></html>")
    const page = send("/guide/", file(), "theme=dark; vitehub-tools=1")
    expect(page).toBeInstanceOf(Response)
    if (!(page instanceof Response)) return
    expect(page.headers.get("cache-control")).toBe("private, no-store")
    expect(await page.text()).toBe(`<html><body>Page${loaderTag}</body></html>`)
  })

  it.each(["string", "bytes", "Response"])("prevents upstream 304s and removes stale validators from direct %s HTML", async (format) => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const onRequest = app.handlers.get("request")![0] as (event: object) => void
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => Promise<void>
    const headers = new Map([["content-type", "text/html; charset=utf-8"], ["etag", '"page"'], ["last-modified", "Mon, 02 Nov 2026 12:00:00 GMT"], ["content-length", "17"], ["cache-control", "public, max-age=60"]])
    const event = {
      web: { request: new Request("http://site.test/guide/", { headers: { accept: "text/html", "if-none-match": '"page"', "if-modified-since": "Mon, 02 Nov 2026 12:00:00 GMT" } }) },
      node: {
        req: { url: "/guide/", headers: { accept: "text/html", "if-none-match": '"page"', "if-modified-since": "Mon, 02 Nov 2026 12:00:00 GMT" } },
        res: { statusCode: 200, getHeader: (name: string) => headers.get(name), removeHeader: (name: string) => headers.delete(name), setHeader: (name: string, value: string) => headers.set(name, value) },
      },
    }
    onRequest(event)
    const notModified = event.web.request.headers.has("if-none-match") || event.web.request.headers.has("if-modified-since") || "if-none-match" in event.node.req.headers || "if-modified-since" in event.node.req.headers
    event.node.res.statusCode = notModified ? 304 : 200
    const html = "<body>Page</body>"
    const body = notModified ? "" : html
    const response = { body: (format === "Response" ? new Response(notModified ? null : html, { status: event.node.res.statusCode, headers: Object.fromEntries(headers) }) : format === "bytes" ? new TextEncoder().encode(body) : body) as unknown }
    await respond(event, response)
    expect(event.node.res.statusCode).toBe(200)
    expect(response.body instanceof Response ? await response.body.text() : response.body).toBe(`<body>Page${bootstrap}</body>`)
    for (const name of ["etag", "last-modified", "content-length"]) {
      expect(headers.has(name)).toBe(false)
      if (response.body instanceof Response) expect(response.body.headers.has(name)).toBe(false)
    }
    expect(headers.get("cache-control")).toBe("public, max-age=60")
  })
})

describe("GET /_vitehub/page/session", () => {
  const app = nitro2App()
  const session = async (cookie: string, headers: Record<string, string> = {}) => {
    const response = await respondViteHubPageSession(app, new Request("http://site.test/_vitehub/page/session", { headers: { cookie, ...headers } }))
    return { response, body: await response.json() as { tools?: unknown[], error?: { code: string } } }
  }

  it("returns the allowed tools with their display fields, and sets the hint cookie", async () => {
    registerViteHubPageTool(app, comments)
    registerViteHubPageTool(app, pill)
    const { response, body } = await session("person=ada")
    expect(body).toEqual({ tools: [
      { id: "comments", label: "COMMENTS", icon: "i-lucide-comments", script: "/comments.js" },
      { id: "console", label: "CONSOLE", icon: "i-lucide-console", hotkey: "k", script: "/console.js" },
    ] })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("set-cookie")).toBe("vitehub-tools=1; Path=/; Max-Age=2592000; SameSite=Lax")
  })

  it("marks a tool lazy for this visitor when its check answers lazy", async () => {
    registerViteHubPageTool(app, { ...comments, allowed: async () => "lazy" })
    const { body, response } = await session("person=ada")
    expect(body.tools).toEqual([{ id: "comments", label: "COMMENTS", icon: "i-lucide-comments", lazy: true, script: "/comments.js" }])
    expect(response.headers.get("set-cookie")).toContain("vitehub-tools=1")
  })

  it("returns only the tools that allow this visitor", async () => {
    registerViteHubPageTool(app, comments)
    registerViteHubPageTool(app, pill)
    const { body, response } = await session("person=ben")
    expect(body.tools).toEqual([{ id: "comments", label: "COMMENTS", icon: "i-lucide-comments", script: "/comments.js" }])
    expect(response.headers.get("set-cookie")).toContain("vitehub-tools=1")
  })

  it("sets the hint cookie to 0 when no tool allows the visitor, also when a check throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    registerViteHubPageTool(app, comments)
    registerViteHubPageTool(app, { ...pill, allowed: async () => { throw new Error("session store down") } })
    const { body, response } = await session("person=eve")
    expect(body).toEqual({ tools: [] })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("set-cookie")).toBe("vitehub-tools=0; Path=/; Max-Age=2592000; SameSite=Lax")
    expect(console.error).toHaveBeenCalledOnce()
  })

  it("rejects other sites before it runs any check", async () => {
    const allowed = vi.fn(async () => true)
    registerViteHubPageTool(app, { ...comments, allowed })
    for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }]) {
      const { body, response } = await session("person=ada", headers)
      expect(response.status).toBe(403)
      expect(body.error?.code).toBe("VITEHUB_PAGE_TOOLS_CROSS_ORIGIN")
      expect(response.headers.get("set-cookie")).toBeNull()
      expect(response.headers.get("cache-control")).toBe("private, no-store")
    }
    expect(allowed).not.toHaveBeenCalled()
    expect((await session("person=ada", { origin: "http://site.test", "sec-fetch-site": "same-origin" })).body.tools).toHaveLength(1)
  })

  it("passes the Request of the session route to the checks", async () => {
    const seen: unknown[] = []
    const app = nitro3App()
    registerViteHubPageTool(app, { ...comments, allowed: async ({ request }) => {
      seen.push(request)
      return true
    } })
    installViteHubPageTools(app)
    const request = new Request("http://site.test/_vitehub/page/session")
    await app.fetch(request)
    expect((await viteHubPageSessionHandler.fetch(request)).status).toBe(200)
    expect(seen).toEqual([request])
  })
})

describe("page tools below an app base", () => {
  const baseTag = loaderTag.replace("src=\"/_vitehub", "src=\"/portal/_vitehub")

  it("skips Console and API paths below the base, and reads the hint on other pages", () => {
    const hint = (path: string) => hasViteHubPageToolsHint(new Request(`http://site.test${path}`), "/portal")
    expect(hint("/portal/blog?vitehub")).toBe(true)
    expect(hint("/portal/?vitehub")).toBe(true)
    expect(hint("/portal/_vitehub/content?vitehub")).toBe(false)
    expect(hint("/portal/api/x?vitehub")).toBe(false)
    // A path that Nitro already took the base from.
    expect(hint("/_vitehub/content?vitehub")).toBe(false)
  })

  it("gives the Nitro 3 loader tag the base that the owner passes", async () => {
    const app = nitro3App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app, { base: "/portal/" })
    expect(await (await app.fetch(new Request("http://site.test/portal/?vitehub"))).text()).toBe(`<html><body>Page${baseTag}</body></html>`)
    expect(await (await app.fetch(new Request("http://site.test/portal/_vitehub/content?vitehub"))).text()).toBe("<html><body>Page</body></html>")
  })

  it("reads the Nitro 2 base from the request, as H3 1 removes it from url and keeps it in originalUrl", async () => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    const render = app.handlers.get("render:html")![0] as (html: { bodyAppend: string[] }, context: unknown) => void
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => void
    const event = (url: string) => ({ node: { req: { url, originalUrl: `/portal${url}`, headers: {} }, res: { setHeader() {} } } })
    const html = { bodyAppend: [] as string[] }
    render(html, { event: event("/?vitehub") })
    expect(html.bodyAppend).toEqual([baseTag])
    const skipped = { bodyAppend: [] as string[] }
    render(skipped, { event: event("/_vitehub/content?vitehub") })
    expect(skipped.bodyAppend).toEqual([])
    const response = { body: new Response("<body></body>", { headers: { "content-type": "text/html; charset=utf-8" } }) as unknown }
    respond(event("/served?vitehub"), response)
    expect(response.body).toBeInstanceOf(Response)
    if (response.body instanceof Response) expect(await response.body.text()).toBe(`<body>${baseTag}</body>`)
  })

  it("adds no second loader to a page that has one, such as a single page app that Vite changed", async () => {
    const page = `<body>${loaderTag}</body>`
    expect(await injectPageToolsLoader(streamed([page])).text()).toBe(page)
    expect(await injectPageToolsLoader(streamed([page.slice(0, 30), page.slice(30)])).text()).toBe(page)
  })

  it("gives the tool scripts the base of the session route", async () => {
    const app = nitro3App()
    installViteHubPageTools(app)
    registerViteHubPageTool(app, comments)
    registerViteHubPageTool(app, { ...pill, script: "https://cdn.test/console.js" })
    const response = await respondViteHubPageSession(app, new Request("http://site.test/portal/_vitehub/page/session", { headers: { cookie: "person=ada" } }))
    expect(await response.json()).toEqual({ tools: [
      expect.objectContaining({ id: "comments", script: "/portal/comments.js" }),
      expect.objectContaining({ id: "console", script: "https://cdn.test/console.js" }),
    ] })
  })
})

describe("per-app page tools", () => {
  it("isolates Nitro 3 loader injection and sessions across bundled copies, late registration and replacement", async () => {
    const makeApp = () => {
      const h3 = new H3().get("/_vitehub/page/session", viteHubPageSessionHandler)
      h3.get("/", () => new Response("<body>Page</body>", { headers: { "content-type": "text/html; charset=utf-8" } }))
      return { fetch: (request: Request) => h3.fetch(request) }
    }
    const appA = makeApp()
    const appB = makeApp()
    const empty = makeApp()
    for (const app of [appA, appB, empty]) installViteHubPageTools(app)
    registerViteHubPageTool(appA, comments)
    vi.resetModules()
    const otherOwner = await import("../src/runtime/page-tools.ts")
    otherOwner.registerViteHubPageTool(appB, { ...comments, script: "/old.js" })
    otherOwner.registerViteHubPageTool(appB, { ...comments, script: "/b.js" })
    otherOwner.registerViteHubPageTool(appB, pill)
    const wrapped = appB.fetch
    otherOwner.installViteHubPageTools(appB)
    expect(appB.fetch).toBe(wrapped)
    const pages = await Promise.all([appA, appB, empty].map(async app => (await app.fetch(new Request("http://site.test/?vitehub"))).text()))
    expect(pages).toEqual([`<body>Page${loaderTag}</body>`, `<body>Page${loaderTag}</body>`, "<body>Page</body>"])
    const sessions = await Promise.all([appA, appB, empty].map(async app => (await app.fetch(new Request("http://site.test/_vitehub/page/session", { headers: { cookie: "person=ada" } }))).json()))
    expect(sessions.map(session => session.tools.map((tool: { script: string }) => tool.script))).toEqual([["/comments.js"], ["/b.js", "/console.js"], []])
    const unbound = await otherOwner.viteHubPageSessionHandler.fetch(new Request("http://site.test/_vitehub/page/session"))
    expect(unbound.status).toBe(503)
  })

  it("isolates Nitro 2 rendered and returned pages", async () => {
    const apps = [nitro2App(), nitro2App(), nitro2App()]
    for (const app of apps) installViteHubPageTools(app)
    registerViteHubPageTool(apps[0]!, comments)
    registerViteHubPageTool(apps[1]!, { ...pill, script: "/b.js" })
    const results = await Promise.all(apps.map(async (app) => {
      const render = app.handlers.get("render:html")![0] as (html: { bodyAppend: string[] }, context: unknown) => void
      const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body: Response }) => void
      const event = { node: { req: { url: "/?vitehub", headers: { host: "site.test", cookie: "person=ada" }, method: "GET", [Symbol.asyncIterator]: async function* () {} } } }
      const html = { bodyAppend: [] as string[] }
      render(html, { event })
      const response = { body: new Response("<body>Page</body>", { headers: { "content-type": "text/html; charset=utf-8" } }) }
      respond(event, response)
      return { tags: html.bodyAppend, page: await response.body.text() }
    }))
    expect(results).toEqual([
      { tags: [loaderTag], page: `<body>Page${loaderTag}</body>` },
      { tags: [loaderTag], page: `<body>Page${loaderTag}</body>` },
      { tags: [], page: "<body>Page</body>" },
    ])
  })
})


describe("mounted page tool exclusions", () => {
  it("applies a late base to Nitro 3 without changing another app", async () => {
    const app = nitro3App()
    const other = nitro3App()
    for (const candidate of [app, other]) {
      registerViteHubPageTool(candidate, comments)
      installViteHubPageTools(candidate)
    }
    const otherOwner = await import("../src/runtime/page-tools.ts")
    otherOwner.installViteHubPageTools(app, { base: "/portal/" })
    installViteHubPageTools(app)
    for (const path of ["/portal/_vitehub", "/portal/_vitehub/comments", "/portal/api", "/portal/api/data"]) {
      expect(await (await app.fetch(new Request(`http://site.test${path}?vitehub`))).text()).not.toContain("data-vitehub-page-tools")
      expect(await (await other.fetch(new Request(`http://site.test${path}?vitehub`))).text()).toContain("data-vitehub-page-tools")
    }
    expect(await (await app.fetch(new Request("http://site.test/portals/_vitehub?vitehub"))).text()).not.toContain("data-vitehub-page-tools")
    for (const path of ["/portal/pricing"]) {
      expect(await (await app.fetch(new Request(`http://site.test${path}?vitehub`))).text()).toContain("data-vitehub-page-tools")
    }
  })

  it("excludes mounted Console and API pages on both Nitro 2 response paths", async () => {
    const app = nitro2App()
    registerViteHubPageTool(app, comments)
    installViteHubPageTools(app)
    installViteHubPageTools(app, { base: "/portal/" })
    const render = app.handlers.get("render:html")![0] as (html: { bodyAppend: string[] }, context: unknown) => void
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body: Response }) => void
    for (const path of ["/portal/_vitehub", "/portal/_vitehub/comments", "/portal/api", "/portal/api/data", "/portal/pricing"]) {
      const event = { node: { req: { url: path, headers: { cookie: "vitehub-tools=1" } } } }
      const html = { bodyAppend: [] as string[] }
      const original = new Response("<body>Page</body>", { headers: { "content-type": "text/html; charset=utf-8" } })
      const response = { body: original }
      render(html, { event })
      respond(event, response)
      if (path.endsWith("pricing")) {
        expect(html.bodyAppend).toEqual([loaderTag.replace("src=\"/_vitehub", "src=\"/portal/_vitehub")])
        expect(await response.body.text()).toContain("data-vitehub-page-tools")
      }
      else {
        expect(html.bodyAppend).toEqual([])
        expect(response.body).toBe(original)
      }
    }
  })
})
