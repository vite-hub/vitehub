import { describe, expect, it } from "vitest"

import { defineCommentsPlugin, wantsCommentMode } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"

const overlayTag = "<script type=\"module\" src=\"/o.js\" data-vitehub-page-tool=\"comments\"></script>"

function install(nitroApp: unknown): void {
  const warn = console.warn
  console.warn = () => {}
  defineCommentsPlugin({ comments: defineComments(), database: () => undefined, overlay: "/o.js" })(nitroApp)
  console.warn = warn
}

describe("overlay injection", () => {
  it("asks for comment mode with ?comments or the hint cookie", () => {
    expect(wantsCommentMode(new Request("http://site.test/pricing?comments"))).toBe(true)
    expect(wantsCommentMode(new Request("http://site.test/", { headers: { cookie: "a=1; vitehub-comments=1" } }))).toBe(true)
    expect(wantsCommentMode(new Request("http://site.test/"))).toBe(false)
    expect(wantsCommentMode(new Request("http://site.test/", { headers: { cookie: "vitehub-comments=0" } }))).toBe(false)
  })

  it("adds the overlay to pages in comment mode on Nitro 3, never on Console or API routes", async () => {
    const nitroApp = { fetch: (_request: Request) => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html" } }) }
    install(nitroApp)
    install(nitroApp)
    const page = async (url: string, cookie = "") => (await nitroApp.fetch(new Request(url, { headers: { cookie } }))).text()
    expect(await page("http://site.test/?comments")).toBe(`<html><body>Page${overlayTag}</body></html>`)
    expect(await page("http://site.test/", "vitehub-comments=1")).toBe(`<html><body>Page${overlayTag}</body></html>`)
    expect(await page("http://site.test/")).toBe("<html><body>Page</body></html>")
    expect(await page("http://site.test/_vitehub/content?comments")).toBe("<html><body>Page</body></html>")
    expect(await page("http://site.test/api/x?comments")).toBe("<html><body>Page</body></html>")
  })

  it("adds the overlay in Nuxt's render:html hook", () => {
    let render: ((html: { bodyAppend: string[] }, context: unknown) => void) | undefined
    install({ hooks: { hook: (name: string, handler: typeof render) => { if (name === "render:html") render = handler } } })
    const page = (url: string) => {
      const html = { bodyAppend: [] as string[] }
      render!(html, { event: { node: { req: { url, headers: {} }, res: { setHeader() {} } } } })
      return html.bodyAppend
    }
    expect(page("/")).toEqual([])
    expect(page("/?comments")).toEqual([overlayTag])
  })
})
