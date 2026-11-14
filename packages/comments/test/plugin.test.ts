import { beforeEach, describe, expect, it, vi } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"
import { viteHubPageToolsInlineScript } from "@vite-hub/internal/runtime/page-tools-shared"

import { commentsApiRoute } from "../src/page.ts"
import { defineCommentsPlugin } from "../src/runtime/plugin.ts"
import { defineComments } from "../src/index.ts"

import type { CommentsUser, DefineCommentsOptions } from "../src/types.ts"
import type { CommentsGitHubLogin } from "../src/runtime/github-login.ts"

const loaderTag = (mount: string) => `<script type="module" src="${mount}/_vitehub/page/assets/loader.js?v=21" data-vitehub-page-tools></script>`

/** Installs Comments with a session that reads the person from a `person` cookie. */
function install(nitroApp: unknown, options: DefineCommentsOptions = {}, overlay = "/o.js"): void {
  const warn = console.warn
  console.warn = () => {}
  const session = async (event: unknown): Promise<CommentsUser | null> => {
    // The page tools session passes its Request.
    const person = event instanceof Request ? /person=(\w+)/.exec(event.headers.get("cookie") ?? "")?.[1] : undefined
    return person ? { id: person, name: person } : null
  }
  const base = commentsApiRoute(new URL(overlay, "http://localhost").href).slice(0, -"/api/_vitehub/comments".length)
  defineCommentsPlugin({ comments: defineComments(options), database: () => undefined, overlay: overlay.slice(base.length), base, session })(nitroApp)
  console.warn = warn
}

async function pageSession(app: object, cookie: string, page?: string) {
  const request = new Request(`http://site.test/_vitehub/page/session${page ? `?page=${encodeURIComponent(page)}` : ""}`, { headers: { cookie } })
  const response = await respondViteHubPageSession(app, request)
  return { cookie: response.headers.get("set-cookie"), body: await response.json() }
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
})

describe("Comments page tool", () => {
  it("checks the active page for subject-aware tool access", async () => {
    const app = {}
    install(app, { authorize: ({ subject }) => subject?.id === "/pricing" })
    const { tools } = (await pageSession(app, "", "/pricing/")).body
    expect(tools).toHaveLength(1)
    // A reader gets the overlay at once, for the selection bar and the highlights.
    expect(tools[0].lazy).toBeUndefined()
    expect((await pageSession(app, "", "/private")).body.tools).toEqual([])
  })

  it("loads the tool on a page that `page` maps to a subject the visitor may read", async () => {
    const app = {}
    install(app, {
      subjects: [{ kind: "drop", scope: () => "drops" }],
      page: ({ url }) => url.pathname.startsWith("/d/") ? { kind: "drop", id: url.pathname.slice(3) } : undefined,
      authorize: ({ subject }) => subject?.kind === "drop" && subject.id === "abc",
    })
    expect((await pageSession(app, "", "/d/abc")).body.tools).toHaveLength(1)
    expect((await pageSession(app, "", "/d/xyz")).body.tools).toEqual([])
  })

  it.each([null, { id: "gh-ada", name: "Ada", github: { login: "ada", write: false } }])("offers the overlay for GitHub sign-in or account switching: %j", async (user) => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const app = {}
    const githubLogin: CommentsGitHubLogin = { configured: () => true, user: async () => user, handle: async () => new Response(null) }
    const options = { comments: defineComments(), database: () => undefined, overlay: "/o.js", githubLogin }
    defineCommentsPlugin(options)(app)
    const session = await pageSession(app, "")
    expect(session.body.tools).toHaveLength(1)
    // Only the button loads at first: the overlay script waits until the person presses it.
    expect(session.body.tools[0]).toMatchObject({ id: "comments", lazy: true })
    expect(session.cookie).toContain("vitehub-tools=1;")
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
      body: { tools: [{ id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/o.js", param: "comment" }] },
    })
    expect(await pageSession(app, "person=ben")).toEqual({ cookie: "vitehub-tools=0; Path=/; Max-Age=2592000; SameSite=Lax", body: { tools: [] } })
    // Without authorize, anonymous people may not read.
    install(app)
    expect((await pageSession(app, "")).body).toEqual({ tools: [] })
  })

  it.each([true, false])("lets custom identify and authorize decide: %s", async (allowed) => {
    const app = {}
    const identify = vi.fn(() => ({ id: "custom", name: "Custom" }))
    defineCommentsPlugin({ comments: defineComments({ identify, authorize: () => allowed }), database: () => undefined, overlay: "/o.js" })(app)
    expect((await pageSession(app, "")).body.tools).toHaveLength(allowed ? 1 : 0)
    expect(identify).toHaveBeenCalledOnce()
  })

  it("finds the API from the mounted overlay URL", () => {
    expect(commentsApiRoute("https://site.test/portal/api/_vitehub/comments/assets/overlay.js?v=1")).toBe("/portal/api/_vitehub/comments")
    expect(commentsApiRoute("https://site.test/api/_vitehub/comments/assets/overlay.js?v=1")).toBe("/api/_vitehub/comments")
  })

  it.each(["", "/portal"])("adds one loader on Nitro 3 under mount %s, never on Console or API routes", async (mount) => {
    const nitroApp = { fetch: (_request: Request) => new Response("<html><body>Page</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }) }
    const overlay = `${mount}/api/_vitehub/comments/assets/overlay.js`
    install(nitroApp, {}, overlay)
    install(nitroApp, {}, overlay)
    const page = async (path: string, cookie = "") => (await nitroApp.fetch(new Request(`http://site.test${path}`, { headers: { cookie } }))).text()
    expect(await page(`${mount}/?vitehub`)).toBe(`<html><body>Page${loaderTag(mount)}</body></html>`)
    expect(await page(`${mount}/`, "vitehub-tools=1")).toBe(`<html><body>Page${loaderTag(mount)}</body></html>`)
    const bootstrap = `<html><body>Page${viteHubPageToolsInlineScript(mount)}</body></html>`
    expect(await page(`${mount}/`)).toBe(bootstrap)
    expect(await page(`${mount}/?comments`, "vitehub-comments=1")).toBe(bootstrap)
    for (const path of ["/_vitehub/content", "/api/x"]) {
      expect(await page(`${mount}${path}?vitehub`, "vitehub-tools=1")).toBe("<html><body>Page</body></html>")
    }
    if (mount) expect(await page("/outside?vitehub")).toBe("<html><body>Page</body></html>")
  })
})
