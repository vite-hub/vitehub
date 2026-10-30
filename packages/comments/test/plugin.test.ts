import { beforeEach, describe, expect, it, vi } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"

import { commentsApiRoute } from "../src/page.ts"
import { commentsConsoleSession } from "../src/runtime/console-session.ts"
import { defineCommentsPlugin } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"

import type { CommentsUser, DefineCommentsOptions } from "../src/types.ts"
import type { CommentsGitHubLogin } from "../src/runtime/github-login.ts"

const loaderTag = (mount: string) => `<script type="module" src="${mount}/_vitehub/page/assets/loader.js?v=8" data-vitehub-page-tools></script>`

/** Installs Comments with a session that reads the person from a `person` cookie. */
function install(nitroApp: unknown, options: DefineCommentsOptions = {}, overlay = "/o.js"): void {
  const warn = console.warn
  console.warn = () => {}
  const session = async (event: unknown): Promise<CommentsUser | null> => {
    const request: unknown = event !== null && typeof event === "object" ? Reflect.get(event, "req") : undefined
    const person = request instanceof Request ? /person=(\w+)/.exec(request.headers.get("cookie") ?? "")?.[1] : undefined
    return person ? { id: person, name: person } : null
  }
  const base = commentsApiRoute(new URL(overlay, "http://localhost").href).slice(0, -"/api/_vitehub/comments".length)
  defineCommentsPlugin({ comments: defineComments(options), database: () => undefined, overlay: overlay.slice(base.length), base, session })(nitroApp)
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
  it.each([null, { id: "gh-ada", name: "Ada", github: { login: "ada", write: false } }])("offers the overlay for GitHub sign-in or account switching: %j", async (user) => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = {}
    const githubLogin: CommentsGitHubLogin = { configured: () => true, user: async () => user, handle: async () => new Response(null) }
    const options = { comments: defineComments(), database: () => undefined, overlay: "/o.js", githubLogin }
    defineCommentsPlugin(options)(app)
    const session = await pageSession(app, "")
    expect(session.body.tools).toHaveLength(1)
    expect(session.cookie).toContain("vitehub-tools=1;")
    defineCommentsPlugin({ ...options, consoleSession: async () => false })(app)
    expect((await pageSession(app, "")).body.tools).toEqual([])
    defineCommentsPlugin({ ...options, comments: defineComments({ identify: () => null }) })(app)
    expect((await pageSession(app, "")).body.tools).toEqual([])
    defineCommentsPlugin({ ...options, githubLogin: { ...githubLogin, configured: () => false } })(app)
    expect((await pageSession(app, "")).body.tools).toEqual([])
    vi.restoreAllMocks()
  })

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
      body: { tools: [{ id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/o.js" }] },
    })
    expect(await pageSession(app, "person=ben")).toEqual({ cookie: "vitehub-tools=; Path=/; Max-Age=0; SameSite=Lax", body: { tools: [] } })
    // Without authorize, anonymous people may not read.
    install(app)
    expect((await pageSession(app, "")).body).toEqual({ tools: [] })
  })

  it.each([true, false])("checks Console read access before Comments identity: %s", async (allowed) => {
    const app = {}
    const identify = vi.fn(() => ({ id: "custom", name: "Custom" }))
    const consoleSession = commentsConsoleSession({
      authorize: async ({ kind }) => allowed && kind !== "write",
      user: async () => null,
      identify: async () => null,
    })
    defineCommentsPlugin({ comments: defineComments({ identify, authorize: () => true }), database: () => undefined, overlay: "/o.js", consoleSession })(app)
    expect((await pageSession(app, "")).body.tools).toHaveLength(allowed ? 1 : 0)
    expect(identify).toHaveBeenCalledTimes(allowed ? 1 : 0)
  })

  it("finds the API from the mounted overlay URL", () => {
    expect(commentsApiRoute("https://site.test/portal/api/_vitehub/comments/assets/overlay.js?v=1")).toBe("/portal/api/_vitehub/comments")
    expect(commentsApiRoute("https://site.test/api/_vitehub/comments/assets/overlay.js?v=1")).toBe("/api/_vitehub/comments")
  })

  it.each(["", "/portal"])("adds one loader on Nitro 3 under mount %s, never on Console or API routes", async (mount) => {
    const nitroApp = { fetch: (_request: Request) => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html" } }) }
    const overlay = `${mount}/api/_vitehub/comments/assets/overlay.js`
    install(nitroApp, {}, overlay)
    install(nitroApp, {}, overlay)
    const page = async (path: string, cookie = "") => (await nitroApp.fetch(new Request(`http://site.test${path}`, { headers: { cookie } }))).text()
    expect(await page(`${mount}/?vitehub`)).toBe(`<html><body>Page${loaderTag(mount)}</body></html>`)
    expect(await page(`${mount}/`, "vitehub-tools=1")).toBe(`<html><body>Page${loaderTag(mount)}</body></html>`)
    expect(await page(`${mount}/`)).toBe("<html><body>Page</body></html>")
    expect(await page(`${mount}/?comments`, "vitehub-comments=1")).toBe("<html><body>Page</body></html>")
    for (const path of ["/_vitehub/content", "/api/x"]) {
      expect(await page(`${mount}${path}?vitehub`, "vitehub-tools=1")).toBe("<html><body>Page</body></html>")
    }
    if (mount) expect(await page("/outside?vitehub")).toBe("<html><body>Page</body></html>")
  })

  it.each([
    { mount: "", stripBase: false },
    { mount: "/portal", stripBase: false },
    { mount: "/portal", stripBase: true },
  ])("adds a nonced loader in Nuxt's render:html hook under mount $mount (base stripped: $stripBase)", ({ mount, stripBase }) => {
    let render: ((html: { bodyAppend: string[] }, context: unknown) => void) | undefined
    install({ hooks: { hook: (name: string, handler: typeof render) => { if (name === "render:html") render = handler } } }, {}, `${mount}/api/_vitehub/comments/assets/overlay.js`)
    const headers: Record<string, string> = {}
    const page = (path: string) => {
      const html = { bodyAppend: [] as string[] }
      const req = { url: stripBase ? path.slice(mount.length) : path, originalUrl: stripBase ? path : undefined, headers: {} }
      render!(html, { event: { node: { req, res: { setHeader: (name: string, value: string) => { headers[name] = value }, getHeader: () => "script-src 'nonce-n1'" } } } })
      return html.bodyAppend
    }
    expect(page(`${mount}/`)).toEqual([])
    expect(headers).toEqual({})
    expect(page(`${mount}/?vitehub`)).toEqual([loaderTag(mount).replace(" data-vitehub", ' nonce="n1" data-vitehub')])
    expect(headers).toEqual({ "cache-control": "private, no-store" })
    expect(page(`${mount}/_vitehub?vitehub`)).toEqual([])
    expect(page(`${mount}/api/x?vitehub`)).toEqual([])
  })

  it.each([
    { mount: "", stripBase: false },
    { mount: "/portal", stripBase: false },
    { mount: "/portal", stripBase: true },
  ])("adds the loader to Nitro 2 Response pages under mount $mount (base stripped: $stripBase)", async ({ mount, stripBase }) => {
    let respond: ((event: unknown, response: { body?: unknown }) => void) | undefined
    install({ hooks: { hook: (name: string, handler: typeof respond) => { if (name === "beforeResponse") respond = handler } } }, {}, `${mount}/api/_vitehub/comments/assets/overlay.js`)
    const send = (path: string, body: unknown, cookie = "") => {
      const response = { body }
      const req = { url: stripBase ? path.slice(mount.length) : path, originalUrl: stripBase ? path : undefined, headers: { cookie } }
      respond!({ node: { req } }, response)
      return response.body
    }
    const file = () => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html", "cache-control": "public, max-age=3600" } })
    const plain = file()
    expect(send(`${mount}/guide/`, plain)).toBe(plain)
    expect(send(`${mount}/guide/`, "<html></html>", "vitehub-tools=1")).toBe("<html></html>")
    expect(send(`${mount}/_vitehub?vitehub`, plain)).toBe(plain)
    expect(send(`${mount}/api/x?vitehub`, plain)).toBe(plain)
    if (mount && !stripBase) expect(send("/outside?vitehub", plain)).toBe(plain)
    const page = send(`${mount}/guide/`, file(), "theme=dark; vitehub-tools=1")
    expect(page).toBeInstanceOf(Response)
    if (!(page instanceof Response)) return
    expect(page.headers.get("cache-control")).toBe("private, no-store")
    expect(await page.text()).toBe(`<html><body>Page${loaderTag(mount)}</body></html>`)
  })
})
