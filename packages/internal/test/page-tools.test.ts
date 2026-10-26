import { beforeEach, describe, expect, it } from "vitest"

import { injectPageScripts, installViteHubPageTools, registerViteHubPageTool, scriptNonce } from "../src/runtime/page-tools.ts"

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

const comments: ViteHubPageTool = { id: "comments", script: "/o.js", wants: request => new URL(request.url).searchParams.has("comments") }
const pill: ViteHubPageTool = { id: "console", script: "/pill.js", wants: request => new URL(request.url).searchParams.has("pill") }
const commentsTag = "<script type=\"module\" src=\"/o.js\" data-vitehub-page-tool=\"comments\"></script>"
const pillTag = "<script type=\"module\" src=\"/pill.js\" data-vitehub-page-tool=\"console\"></script>"

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

describe("injectPageScripts", () => {
  it("adds the scripts before </body>, also when the tag spans two chunks", async () => {
    const response = injectPageScripts(streamed(["<html><body><h1>Hi</h1></bo", "dy></html>"]), [comments])
    expect(await response.text()).toBe(`<html><body><h1>Hi</h1>${commentsTag}</body></html>`)
    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  it("gives the scripts the nonce of the page's Content Security Policy, which 'strict-dynamic' needs", async () => {
    const policy = "default-src 'self'; script-src 'self' 'strict-dynamic' 'nonce-a1B2+c/3=='; style-src 'self' 'nonce-style'"
    expect(scriptNonce(new Headers({ "content-security-policy": policy }))).toBe("a1B2+c/3==")
    expect(scriptNonce(new Headers({ "content-security-policy": "default-src 'self' 'nonce-xyz'" }))).toBe("xyz")
    expect(scriptNonce(new Headers({ "content-security-policy": "script-src-elem 'nonce-elem'; script-src 'nonce-other'" }))).toBe("elem")
    expect(scriptNonce(new Headers())).toBeUndefined()
    const page = new Response("<body></body>", { headers: { "content-type": "text/html", "content-security-policy": policy } })
    expect(await injectPageScripts(page, [comments]).text()).toBe("<body><script type=\"module\" src=\"/o.js\" nonce=\"a1B2+c/3==\" data-vitehub-page-tool=\"comments\"></script></body>")
  })

  it("appends the scripts to HTML without a body tag, and leaves other responses alone", async () => {
    expect(await injectPageScripts(streamed(["<h1>Hi</h1>"]), [comments]).text()).toBe(`<h1>Hi</h1>${commentsTag}`)
    const json = streamed(["{}"], "application/json")
    expect(injectPageScripts(json, [comments])).toBe(json)
    const missing = new Response("<body></body>", { headers: { "content-type": "text/html" }, status: 404 })
    expect(injectPageScripts(missing, [comments])).toBe(missing)
  })

  it("returns the page unchanged without tools", () => {
    const page = streamed(["<body></body>"])
    expect(injectPageScripts(page, [])).toBe(page)
  })
})

describe("installViteHubPageTools on Nitro 3", () => {
  it("adds one tag per wanted tool in one pass, with one fetch wrapper", async () => {
    const app = nitro3App()
    registerViteHubPageTool(comments)
    installViteHubPageTools(app)
    registerViteHubPageTool(pill)
    installViteHubPageTools(app)
    const response = await app.fetch(new Request("http://site.test/?comments&pill"))
    expect(await response.text()).toBe(`<html><body>Page${commentsTag}${pillTag}</body></html>`)
    expect(app.calls).toBe(1)
  })

  it("wraps fetch once when it is installed twice", async () => {
    const app = nitro3App()
    installViteHubPageTools(app)
    const wrapped = app.fetch
    installViteHubPageTools(app)
    expect(app.fetch).toBe(wrapped)
    registerViteHubPageTool(comments)
    expect(await (await app.fetch(new Request("http://site.test/?comments"))).text()).toBe(`<html><body>Page${commentsTag}</body></html>`)
  })

  it("adds nothing for a tool that does not want the request, and keeps the page cacheable", async () => {
    const app = nitro3App()
    registerViteHubPageTool(comments)
    installViteHubPageTools(app)
    const response = await app.fetch(new Request("http://site.test/"))
    expect(await response.text()).toBe("<html><body>Page</body></html>")
    expect(response.headers.get("cache-control")).toBeNull()
  })

  it("adds one tag when the same id is registered twice, with the last script", async () => {
    const app = nitro3App()
    registerViteHubPageTool({ ...comments, script: "/old.js" })
    registerViteHubPageTool(comments)
    installViteHubPageTools(app)
    expect(await (await app.fetch(new Request("http://site.test/?comments"))).text()).toBe(`<html><body>Page${commentsTag}</body></html>`)
  })

  it("never adds a tool to Console or API routes", async () => {
    const app = nitro3App()
    const seen: string[] = []
    registerViteHubPageTool({ ...comments, wants: (request) => {
      seen.push(new URL(request.url).pathname)
      return true
    } })
    installViteHubPageTools(app)
    for (const path of ["/_vitehub/content", "/api/x"]) {
      expect(await (await app.fetch(new Request(`http://site.test${path}?comments`))).text()).toBe("<html><body>Page</body></html>")
    }
    expect(seen).toEqual([])
  })
})

describe("installViteHubPageTools on Nitro 2", () => {
  it("adds the scripts in Nuxt's render:html hook, and keeps that page out of shared caches", () => {
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
    expect(page("/?comments")).toEqual([commentsTag])
    expect(headers).toEqual({ "cache-control": "private, no-store" })
    expect(page("/?comments&pill")).toEqual([commentsTag + pillTag])
    const html = { bodyAppend: [] as string[] }
    render(html, { event: { node: { req: { url: "/?comments", headers: {} }, res: { setHeader() {}, getHeader: () => "script-src 'self' 'strict-dynamic' 'nonce-n1'" } } } })
    expect(html.bodyAppend[0]).toContain("nonce=\"n1\"")
  })

  it("adds the scripts to a page that a route returns as a Response, such as a prerendered file", async () => {
    const app = nitro2App()
    registerViteHubPageTool({ ...comments, wants: request => Boolean(request.headers.get("cookie")?.includes("vitehub-comments=1")) })
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
    expect(send("/guide/", "<html></html>", "vitehub-comments=1")).toBe("<html></html>")
    const page = send("/guide/", file(), "theme=dark; vitehub-comments=1")
    expect(page).toBeInstanceOf(Response)
    if (!(page instanceof Response)) return
    expect(page.headers.get("cache-control")).toBe("private, no-store")
    expect(await page.text()).toBe(`<html><body>Page${commentsTag}</body></html>`)
  })
})
