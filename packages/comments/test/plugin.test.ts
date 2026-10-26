import { beforeEach, describe, expect, it } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"

import { defineCommentsPlugin } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"

import type { CommentsUser, DefineCommentsOptions } from "../src/types.ts"

const loaderTag = "<script type=\"module\" src=\"/_vitehub/page/assets/loader.js?v=3\" data-vitehub-page-tools></script>"

/** Installs Comments with a session that reads the person from a `person` cookie. */
function install(nitroApp: unknown, options: DefineCommentsOptions = {}): void {
  const warn = console.warn
  console.warn = () => {}
  const session = async (event: unknown): Promise<CommentsUser | null> => {
    const request: unknown = event !== null && typeof event === "object" ? Reflect.get(event, "req") : undefined
    const person = request instanceof Request ? /person=(\w+)/.exec(request.headers.get("cookie") ?? "")?.[1] : undefined
    return person ? { id: person, name: person } : null
  }
  defineCommentsPlugin({ comments: defineComments(options), database: () => undefined, overlay: "/o.js", session })(nitroApp)
  console.warn = warn
}

async function pageSession(cookie: string) {
  const request = new Request("http://site.test/_vitehub/page/session", { headers: { cookie } })
  const response = await respondViteHubPageSession(request, { req: request })
  return { cookie: response.headers.get("set-cookie"), body: await response.json() }
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
})

describe("Comments page tool", () => {
  it("lets a visitor load the overlay when authorize allows read", async () => {
    install({}, { authorize: ({ user, action }) => action === "read" && user?.id === "ada" })
    expect(await pageSession("person=ada")).toEqual({
      cookie: "vitehub-tools=1; Path=/; Max-Age=2592000; SameSite=Lax",
      body: { tools: [{ id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/o.js" }] },
    })
    expect(await pageSession("person=ben")).toEqual({ cookie: "vitehub-tools=; Path=/; Max-Age=0; SameSite=Lax", body: { tools: [] } })
    // Without authorize, anonymous people may not read.
    install({})
    expect((await pageSession("")).body).toEqual({ tools: [] })
  })

  it("adds the loader to pages with the hint on Nitro 3, never on Console or API routes", async () => {
    const nitroApp = { fetch: (_request: Request) => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html" } }) }
    install(nitroApp)
    install(nitroApp)
    const page = async (url: string, cookie = "") => (await nitroApp.fetch(new Request(url, { headers: { cookie } }))).text()
    expect(await page("http://site.test/?vitehub")).toBe(`<html><body>Page${loaderTag}</body></html>`)
    expect(await page("http://site.test/", "vitehub-tools=1")).toBe(`<html><body>Page${loaderTag}</body></html>`)
    expect(await page("http://site.test/")).toBe("<html><body>Page</body></html>")
    expect(await page("http://site.test/?comments", "vitehub-comments=1")).toBe("<html><body>Page</body></html>")
    expect(await page("http://site.test/_vitehub/content?vitehub")).toBe("<html><body>Page</body></html>")
    expect(await page("http://site.test/api/x?vitehub")).toBe("<html><body>Page</body></html>")
  })

  it("adds the loader in Nuxt's render:html hook", () => {
    let render: ((html: { bodyAppend: string[] }, context: unknown) => void) | undefined
    install({ hooks: { hook: (name: string, handler: typeof render) => { if (name === "render:html") render = handler } } })
    const page = (url: string) => {
      const html = { bodyAppend: [] as string[] }
      render!(html, { event: { node: { req: { url, headers: {} }, res: { setHeader() {} } } } })
      return html.bodyAppend
    }
    expect(page("/")).toEqual([])
    expect(page("/?vitehub")).toEqual([loaderTag])
  })
})
