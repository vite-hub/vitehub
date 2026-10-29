import { describe, expect, it } from "vitest"

import { defineCommentsPlugin, wantsCommentMode } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"
import { commentsApiRoute } from "../src/page.ts"

const overlayTag = "<script type=\"module\" src=\"/o.js\" data-vitehub-page-tool=\"comments\"></script>"

function install(nitroApp: unknown, overlay = "/o.js"): void {
  const warn = console.warn
  console.warn = () => {}
  defineCommentsPlugin({ comments: defineComments(), database: () => undefined, overlay })(nitroApp)
  console.warn = warn
}

describe("overlay injection", () => {
  it("keeps each app's overlay URL when another app installs Comments", async () => {
    const makeApp = () => ({ fetch: (_request: Request) => new Response("<body>Page</body>", { headers: { "content-type": "text/html" } }) })
    const appA = makeApp()
    const appB = makeApp()
    install(appA)
    install(appB, "/app-b.js")
    expect(await (await appA.fetch(new Request("http://site.test/?comments"))).text()).toBe(`<body>Page${overlayTag}</body>`)
    expect(await (await appB.fetch(new Request("http://site.test/?comments"))).text()).toBe(`<body>Page${overlayTag.replace("/o.js", "/app-b.js")}</body>`)
  })

  it("uses the script's application mount for API calls and HTML injection", () => {
    expect(commentsApiRoute("https://site.test/portal/api/_vitehub/comments/assets/overlay.js?v=1")).toBe("/portal/api/_vitehub/comments")
    expect(commentsApiRoute("https://site.test/api/_vitehub/comments/assets/overlay.js?v=1")).toBe("/api/_vitehub/comments")
    expect(wantsCommentMode(new Request("http://site.test/portal/?comments"), "/portal")).toBe(true)
    expect(wantsCommentMode(new Request("http://site.test/portal/_vitehub/content?comments"), "/portal")).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/portal/api/x?comments"), "/portal")).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/other?comments"), "/portal")).toBe(false)
  })

  it("asks for comment mode with ?comments or the hint cookie, never on Console or API routes", () => {
    expect(wantsCommentMode(new Request("http://site.test/pricing?comments"))).toBe(true)
    expect(wantsCommentMode(new Request("http://site.test/", { headers: { cookie: "a=1; vitehub-comments=1" } }))).toBe(true)
    expect(wantsCommentMode(new Request("http://site.test/"))).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/", { headers: { cookie: "vitehub-comments=0" } }))).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/_vitehub/content?comments"))).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/api/x?comments"))).toBe(false)
  })

  it.each(["", "/portal"])("ignores reserved routes with a hint cookie under mount %s", (mount) => {
    for (const path of ["/_vitehub/content", "/api/x"]) {
      expect(wantsCommentMode(new Request(`http://site.test${mount}${path}`, { headers: { cookie: "vitehub-comments=1" } }), mount)).toBe(false)
    }
  })

  it.each(["", "/portal"])("adds the overlay on Nitro 3 under mount %s, never on Console or API routes", async (mount) => {
    const nitroApp = { fetch: (_request: Request) => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html" } }) }
    const overlay = `${mount}/api/_vitehub/comments/assets/overlay.js`
    const tag = overlayTag.replace("/o.js", overlay)
    install(nitroApp, overlay)
    install(nitroApp, overlay)
    const page = async (url: string, cookie = "") => (await nitroApp.fetch(new Request(url, { headers: { cookie } }))).text()
    expect(await page(`http://site.test${mount}/?comments`)).toBe(`<html><body>Page${tag}</body></html>`)
    expect(await page(`http://site.test${mount}/`, "vitehub-comments=1")).toBe(`<html><body>Page${tag}</body></html>`)
    expect(await page(`http://site.test${mount}/`)).toBe("<html><body>Page</body></html>")
    expect(await page(`http://site.test${mount}/_vitehub/content?comments`)).toBe("<html><body>Page</body></html>")
    expect(await page(`http://site.test${mount}/api/x?comments`)).toBe("<html><body>Page</body></html>")
    if (mount) expect(await page("http://site.test/outside?comments")).toBe("<html><body>Page</body></html>")
  })

  it.each([
    { mount: "", stripBase: false },
    { mount: "/portal", stripBase: false },
    { mount: "/portal", stripBase: true },
  ])("adds a nonced script in Nuxt's render:html hook under mount $mount (base stripped: $stripBase), and keeps the page out of shared caches", ({ mount, stripBase }) => {
    let render: ((html: { bodyAppend: string[] }, context: unknown) => void) | undefined
    const nitroApp = { hooks: { hook: (name: string, handler: typeof render) => { if (name === "render:html") render = handler } } }
    const warn = console.warn
    console.warn = () => {}
    const overlay = `${mount}/api/_vitehub/comments/assets/overlay.js`
    defineCommentsPlugin({ comments: defineComments(), database: () => undefined, overlay })(nitroApp)
    console.warn = warn
    const headers: Record<string, string> = {}
    const page = (url: string) => {
      const html = { bodyAppend: [] as string[] }
      const req = { url: stripBase && url.startsWith(`${mount}/`) ? url.slice(mount.length) : url, originalUrl: stripBase ? url : undefined, headers: {} }
      render!(html, { event: { node: { req, res: { setHeader: (name: string, value: string) => { headers[name] = value } } } } })
      return html.bodyAppend
    }
    expect(page(`${mount}/`)).toEqual([])
    expect(headers).toEqual({})
    expect(page(`${mount}/?comments`)).toEqual([`<script type="module" src="${overlay}" data-vitehub-page-tool="comments"></script>`])
    expect(page(`${mount}/_vitehub?comments`)).toEqual([])
    expect(page(`${mount}/api/x?comments`)).toEqual([])
    if (mount) expect(page("/outside?comments")).toEqual([])
    expect(headers).toEqual({ "cache-control": "private, no-store" })
    const html = { bodyAppend: [] as string[] }
    render!(html, { event: { node: { req: { url: `${mount}/?comments`, headers: {} }, res: { setHeader() {}, getHeader: () => "script-src 'self' 'strict-dynamic' 'nonce-n1'" } } } })
    expect(html.bodyAppend[0]).toContain("nonce=\"n1\"")
  })

  it.each([
    { mount: "", stripBase: false },
    { mount: "/portal", stripBase: false },
    { mount: "/portal", stripBase: true },
  ])("adds the script to a page returned as a Response by a Nitro 2 route under mount $mount (base stripped: $stripBase)", async ({ mount, stripBase }) => {
    let respond: ((event: unknown, response: { body?: unknown }) => void) | undefined
    const nitroApp = { hooks: { hook: (name: string, handler: typeof respond) => { if (name === "beforeResponse") respond = handler } } }
    const warn = console.warn
    console.warn = () => {}
    const overlay = `${mount}/api/_vitehub/comments/assets/overlay.js`
    defineCommentsPlugin({ comments: defineComments(), database: () => undefined, overlay })(nitroApp)
    console.warn = warn
    const send = (url: string, body: unknown, cookie = "") => {
      const response = { body }
      const req = { url: stripBase && url.startsWith(`${mount}/`) ? url.slice(mount.length) : url, originalUrl: stripBase ? url : undefined, headers: { cookie } }
      respond!({ node: { req } }, response)
      return response.body
    }
    const file = () => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html", "cache-control": "public, max-age=3600" } })
    const plain = file()
    expect(send(`${mount}/guide/`, plain)).toBe(plain)
    expect(send(`${mount}/guide/`, "<html></html>", "vitehub-comments=1")).toBe("<html></html>")
    expect(send(`${mount}/_vitehub?comments`, plain)).toBe(plain)
    expect(send(`${mount}/api/x?comments`, plain)).toBe(plain)
    if (mount) expect(send("/outside?comments", plain)).toBe(plain)
    const page = send(`${mount}/guide/`, file(), "theme=dark; vitehub-comments=1")
    expect(page).toBeInstanceOf(Response)
    if (!(page instanceof Response)) return
    expect(page.headers.get("cache-control")).toBe("private, no-store")
    expect(await page.text()).toBe(`<html><body>Page<script type="module" src="${overlay}" data-vitehub-page-tool="comments"></script></body></html>`)
  })
})
