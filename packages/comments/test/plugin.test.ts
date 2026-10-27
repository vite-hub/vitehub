import { beforeEach, describe, expect, it } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"

import { defineCommentsPlugin } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"

import type { CommentsUser, DefineCommentsOptions } from "../src/types.ts"

const loaderTag = "<script type=\"module\" src=\"/_vitehub/page/assets/loader.js?v=4\" data-vitehub-page-tools></script>"

/** Installs Comments with a session that reads the person from a `person` cookie. */
function install(nitroApp: unknown, options: DefineCommentsOptions = {}, overlay = "/o.js"): void {
  const warn = console.warn
  console.warn = () => {}
  const session = async (event: unknown): Promise<CommentsUser | null> => {
    const request: unknown = event !== null && typeof event === "object" ? Reflect.get(event, "req") : undefined
    const person = request instanceof Request ? /person=(\w+)/.exec(request.headers.get("cookie") ?? "")?.[1] : undefined
    return person ? { id: person, name: person } : null
  }
  defineCommentsPlugin({ comments: defineComments(options), database: () => undefined, overlay, session })(nitroApp)
  console.warn = warn
}

async function pageSession(app: object, cookie: string) {
  const request = new Request("http://site.test/_vitehub/page/session", { headers: { cookie } })
  const response = await respondViteHubPageSession(app, request, { req: request })
  return { cookie: response.headers.get("set-cookie"), body: await response.json() }
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
})

describe("Comments page tool", () => {
  it("keeps each app's overlay URL and authorization when another app installs Comments", async () => {
    const appA = {}
    const appB = {}
    install(appA, { authorize: ({ user }) => user?.id === "ada" })
    install(appB, { authorize: ({ user }) => user?.id === "ben" }, "/b.js")
    expect((await pageSession(appA, "person=ada")).body.tools[0].script).toBe("/o.js")
    expect((await pageSession(appB, "person=ada")).body).toEqual({ tools: [] })
    expect((await pageSession(appB, "person=ben")).body.tools[0].script).toBe("/b.js")
    expect((await pageSession(appA, "person=ben")).body).toEqual({ tools: [] })
  })

  it("lets a visitor load the overlay when authorize allows read", async () => {
    const app = {}
    install(app, { authorize: ({ user, action }) => action === "read" && user?.id === "ada" })
    expect(await pageSession(app, "person=ada")).toEqual({
      cookie: "vitehub-tools=1; Path=/; Max-Age=2592000; SameSite=Lax",
      body: { tools: [{ id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/o.js", lazy: true }] },
    })
    expect(await pageSession(app, "person=ben")).toEqual({ cookie: "vitehub-tools=; Path=/; Max-Age=0; SameSite=Lax", body: { tools: [] } })
    // Without authorize, anonymous people may not read.
    install(app)
    expect((await pageSession(app, "")).body).toEqual({ tools: [] })
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
