import { describe, expect, it } from "vitest"

import { defineCommentsPlugin, injectOverlay, scriptNonce, wantsCommentMode } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"
import { commentsApiRoute } from "../src/page.ts"

function streamed(chunks: string[], type = "text/html; charset=utf-8"): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  }), { headers: { "content-type": type, "content-length": "999" } })
}

describe("overlay injection", () => {
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
    expect(wantsCommentMode(new Request("http://site.test/_vitehub/content?comments"))).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/api/x?comments"))).toBe(false)
  })

  it("adds the script before </body>, also when the tag spans two chunks", async () => {
    const response = injectOverlay(streamed(["<html><body><h1>Hi</h1></bo", "dy></html>"]), "/o.js")
    expect(await response.text()).toBe("<html><body><h1>Hi</h1><script type=\"module\" src=\"/o.js\" data-vitehub-comments></script></body></html>")
    expect(response.headers.get("content-length")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  it("gives the script the nonce of the page's Content Security Policy, which 'strict-dynamic' needs", async () => {
    const policy = "default-src 'self'; script-src 'self' 'strict-dynamic' 'nonce-a1B2+c/3=='; style-src 'self' 'nonce-style'"
    expect(scriptNonce(new Headers({ "content-security-policy": policy }))).toBe("a1B2+c/3==")
    expect(scriptNonce(new Headers({ "content-security-policy": "default-src 'self' 'nonce-xyz'" }))).toBe("xyz")
    expect(scriptNonce(new Headers())).toBeUndefined()
    const page = new Response("<body></body>", { headers: { "content-type": "text/html", "content-security-policy": policy } })
    expect(await injectOverlay(page, "/o.js").text()).toBe("<body><script type=\"module\" src=\"/o.js\" nonce=\"a1B2+c/3==\" data-vitehub-comments></script></body>")
  })

  it("appends the script to HTML without a body tag, and leaves other responses alone", async () => {
    expect(await injectOverlay(streamed(["<h1>Hi</h1>"]), "/o.js").text()).toBe("<h1>Hi</h1><script type=\"module\" src=\"/o.js\" data-vitehub-comments></script>")
    const json = streamed(["{}"], "application/json")
    expect(injectOverlay(json, "/o.js")).toBe(json)
  })

  it.each(["", "/portal"])("adds a nonced script in Nuxt's render:html hook under mount %s, and keeps the page out of shared caches", (mount) => {
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
      render!(html, { event: { node: { req: { url, headers: {} }, res: { setHeader: (name: string, value: string) => { headers[name] = value } } } } })
      return html.bodyAppend
    }
    expect(page(`${mount}/`)).toEqual([])
    expect(headers).toEqual({})
    expect(page(`${mount}/?comments`)).toEqual([`<script type="module" src="${overlay}" data-vitehub-comments></script>`])
    expect(page(`${mount}/_vitehub?comments`)).toEqual([])
    if (mount) expect(page("/outside?comments")).toEqual([])
    expect(headers).toEqual({ "cache-control": "private, no-store" })
    const html = { bodyAppend: [] as string[] }
    render!(html, { event: { node: { req: { url: `${mount}/?comments`, headers: {} }, res: { setHeader() {}, getHeader: () => "script-src 'self' 'strict-dynamic' 'nonce-n1'" } } } })
    expect(html.bodyAppend[0]).toContain("nonce=\"n1\"")
  })
})
