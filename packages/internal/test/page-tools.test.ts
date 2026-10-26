import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { hasViteHubPageToolsHint, injectPageToolsLoader, installViteHubPageTools, registerViteHubPageTool, respondViteHubPageSession, scriptNonce, viteHubPageSessionHandler } from "../src/runtime/page-tools.ts"

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
const loaderTag = "<script type=\"module\" src=\"/_vitehub/page/assets/loader.js?v=3\" data-vitehub-page-tools></script>"

/** A Nitro 3 app whose fetch returns one HTML page, and counts its calls. */
function nitro3App(html = "<html><body>Page</body></html>") {
  const app = {
    calls: 0,
    fetch(_request: Request): Response {
      app.calls++
      return new Response(html, { headers: { "content-type": "text/html" } })
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

  it("gives the loader the nonce of the page's Content Security Policy, which 'strict-dynamic' needs", async () => {
    const policy = "default-src 'self'; script-src 'self' 'strict-dynamic' 'nonce-a1B2+c/3=='; style-src 'self' 'nonce-style'"
    expect(scriptNonce(new Headers({ "content-security-policy": policy }))).toBe("a1B2+c/3==")
    expect(scriptNonce(new Headers({ "content-security-policy": "default-src 'self' 'nonce-xyz'" }))).toBe("xyz")
    expect(scriptNonce(new Headers({ "content-security-policy": "script-src-elem 'nonce-elem'; script-src 'nonce-other'" }))).toBe("elem")
    expect(scriptNonce(new Headers())).toBeUndefined()
    const page = new Response("<body></body>", { headers: { "content-type": "text/html", "content-security-policy": policy } })
    expect(await injectPageToolsLoader(page).text()).toBe("<body><script type=\"module\" src=\"/_vitehub/page/assets/loader.js?v=3\" nonce=\"a1B2+c/3==\" data-vitehub-page-tools></script></body>")
  })

  it("appends the loader to HTML without a body tag, and leaves other responses alone", async () => {
    expect(await injectPageToolsLoader(streamed(["<h1>Hi</h1>"])).text()).toBe(`<h1>Hi</h1>${loaderTag}`)
    const json = streamed(["{}"], "application/json")
    expect(injectPageToolsLoader(json)).toBe(json)
    const missing = new Response("<body></body>", { headers: { "content-type": "text/html" }, status: 404 })
    expect(injectPageToolsLoader(missing)).toBe(missing)
  })
})

describe("installViteHubPageTools on Nitro 3", () => {
  it("adds exactly one loader tag for any number of tools, with one fetch wrapper", async () => {
    const app = nitro3App()
    registerViteHubPageTool(comments)
    installViteHubPageTools(app)
    registerViteHubPageTool(pill)
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
    registerViteHubPageTool(comments)
    expect(await (await app.fetch(new Request("http://site.test/?vitehub"))).text()).toBe(`<html><body>Page${loaderTag}</body></html>`)
  })

  it("adds nothing without the hint, or without a registered tool, and keeps the page cacheable", async () => {
    const app = nitro3App()
    installViteHubPageTools(app)
    const none = await app.fetch(new Request("http://site.test/?vitehub"))
    expect(await none.text()).toBe("<html><body>Page</body></html>")
    registerViteHubPageTool(comments)
    const response = await app.fetch(new Request("http://site.test/"))
    expect(await response.text()).toBe("<html><body>Page</body></html>")
    expect(response.headers.get("cache-control")).toBeNull()
  })

  it("never adds the loader to Console or API routes", async () => {
    const app = nitro3App()
    registerViteHubPageTool(comments)
    installViteHubPageTools(app)
    for (const path of ["/_vitehub/content", "/api/x"]) {
      expect(await (await app.fetch(new Request(`http://site.test${path}?vitehub`))).text()).toBe("<html><body>Page</body></html>")
    }
  })
})

describe("installViteHubPageTools on Nitro 2", () => {
  it("adds the loader in Nuxt's render:html hook, and keeps that page out of shared caches", () => {
    const app = nitro2App()
    registerViteHubPageTool(comments)
    registerViteHubPageTool(pill)
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
    expect(page("/")).toEqual([])
    expect(headers).toEqual({})
    expect(page("/?vitehub")).toEqual([loaderTag])
    expect(headers).toEqual({ "cache-control": "private, no-store" })
    const html = { bodyAppend: [] as string[] }
    render(html, { event: { node: { req: { url: "/?vitehub", headers: {} }, res: { setHeader() {}, getHeader: () => "script-src 'self' 'strict-dynamic' 'nonce-n1'" } } } })
    expect(html.bodyAppend[0]).toContain("nonce=\"n1\"")
  })

  it("adds the loader to a page that a route returns as a Response, such as a prerendered file", async () => {
    const app = nitro2App()
    registerViteHubPageTool(comments)
    installViteHubPageTools(app)
    const respond = app.handlers.get("beforeResponse")![0] as (event: unknown, response: { body?: unknown }) => void
    const send = (url: string, body: unknown, cookie = "") => {
      const response = { body }
      respond({ node: { req: { url, headers: { cookie } } } }, response)
      return response.body
    }
    const file = () => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html", "cache-control": "public, max-age=3600" } })
    const plain = file()
    expect(send("/guide/", plain)).toBe(plain)
    expect(send("/guide/", "<html></html>", "vitehub-tools=1")).toBe("<html></html>")
    const page = send("/guide/", file(), "theme=dark; vitehub-tools=1")
    expect(page).toBeInstanceOf(Response)
    if (!(page instanceof Response)) return
    expect(page.headers.get("cache-control")).toBe("private, no-store")
    expect(await page.text()).toBe(`<html><body>Page${loaderTag}</body></html>`)
  })
})

describe("GET /_vitehub/page/session", () => {
  const session = async (cookie: string, headers: Record<string, string> = {}) => {
    const response = await respondViteHubPageSession(new Request("http://site.test/_vitehub/page/session", { headers: { cookie, ...headers } }), {})
    return { response, body: await response.json() as { tools?: unknown[], error?: { code: string } } }
  }

  it("returns the allowed tools with their display fields, and sets the hint cookie", async () => {
    registerViteHubPageTool(comments)
    registerViteHubPageTool(pill)
    const { response, body } = await session("person=ada")
    expect(body).toEqual({ tools: [
      { id: "comments", label: "COMMENTS", icon: "i-lucide-comments", script: "/comments.js" },
      { id: "console", label: "CONSOLE", icon: "i-lucide-console", hotkey: "k", script: "/console.js" },
    ] })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("set-cookie")).toBe("vitehub-tools=1; Path=/; Max-Age=2592000; SameSite=Lax")
  })

  it("returns only the tools that allow this visitor", async () => {
    registerViteHubPageTool(comments)
    registerViteHubPageTool(pill)
    const { body, response } = await session("person=ben")
    expect(body.tools).toEqual([{ id: "comments", label: "COMMENTS", icon: "i-lucide-comments", script: "/comments.js" }])
    expect(response.headers.get("set-cookie")).toContain("vitehub-tools=1")
  })

  it("clears the hint cookie when no tool allows the visitor, also when a check throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    registerViteHubPageTool(comments)
    registerViteHubPageTool({ ...pill, allowed: async () => { throw new Error("session store down") } })
    const { body, response } = await session("person=eve")
    expect(body).toEqual({ tools: [] })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("set-cookie")).toBe("vitehub-tools=; Path=/; Max-Age=0; SameSite=Lax")
    expect(console.error).toHaveBeenCalledOnce()
  })

  it("rejects other sites before it runs any check", async () => {
    const allowed = vi.fn(async () => true)
    registerViteHubPageTool({ ...comments, allowed })
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

  it("passes the H3 event to the checks, from H3 2 and H3 1 events", async () => {
    const seen: unknown[] = []
    registerViteHubPageTool({ ...comments, allowed: async ({ event, request }) => {
      seen.push(event, new URL(request.url).pathname)
      return true
    } })
    const h3 = { req: new Request("http://site.test/_vitehub/page/session") }
    expect((await viteHubPageSessionHandler(h3)).status).toBe(200)
    const h3v1 = { node: { req: { url: "/_vitehub/page/session", method: "GET", headers: { host: "site.test" }, [Symbol.asyncIterator]: async function* () {} } } }
    expect((await viteHubPageSessionHandler(h3v1)).status).toBe(200)
    expect(seen).toEqual([h3, "/_vitehub/page/session", h3v1, "/_vitehub/page/session"])
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
    registerViteHubPageTool(comments)
    installViteHubPageTools(app, { base: "/portal/" })
    expect(await (await app.fetch(new Request("http://site.test/portal/?vitehub"))).text()).toBe(`<html><body>Page${baseTag}</body></html>`)
    expect(await (await app.fetch(new Request("http://site.test/portal/_vitehub/content?vitehub"))).text()).toBe("<html><body>Page</body></html>")
  })

  it("reads the Nitro 2 base from the request, as H3 1 removes it from url and keeps it in originalUrl", async () => {
    const app = nitro2App()
    registerViteHubPageTool(comments)
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
    const response = { body: new Response("<body></body>", { headers: { "content-type": "text/html" } }) as unknown }
    respond(event("/served?vitehub"), response)
    expect(response.body).toBeInstanceOf(Response)
    if (response.body instanceof Response) expect(await response.body.text()).toBe(`<body>${baseTag}</body>`)
  })

  it("adds no second loader to a page that has one, such as a single page app that Vite changed", async () => {
    const page = "<body><script type=\"module\" data-vitehub-page-tools>import(\"/x\")</script></body>"
    expect(await injectPageToolsLoader(streamed([page])).text()).toBe(page)
    expect(await injectPageToolsLoader(streamed([page.slice(0, 30), page.slice(30)])).text()).toBe(page)
  })

  it("gives the tool scripts the base of the session route", async () => {
    registerViteHubPageTool(comments)
    registerViteHubPageTool({ ...pill, script: "https://cdn.test/console.js" })
    const response = await respondViteHubPageSession(new Request("http://site.test/portal/_vitehub/page/session", { headers: { cookie: "person=ada" } }), {})
    expect(await response.json()).toEqual({ tools: [
      expect.objectContaining({ id: "comments", script: "/portal/comments.js" }),
      expect.objectContaining({ id: "console", script: "https://cdn.test/console.js" }),
    ] })
    const h3v1 = { node: { req: { url: "/_vitehub/page/session", originalUrl: "/portal/_vitehub/page/session", method: "GET", headers: { host: "site.test", cookie: "person=ada" }, [Symbol.asyncIterator]: async function* () {} } } }
    expect(await (await viteHubPageSessionHandler(h3v1)).json()).toMatchObject({ tools: [{ id: "comments", script: "/portal/comments.js" }, { id: "console" }] })
  })
})
