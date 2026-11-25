import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installViteHubPageTools, registerViteHubPageTool, respondViteHubPageSession, viteHubSiteVisitorReader } from "@vite-hub/internal/runtime/page-tools"
import { readViteHubPageSession } from "@vite-hub/internal/runtime/page-tools-shared"
import { signSiteHandoff, siteStateHash, signSiteToken } from "@vite-hub/internal/site-token"

import { defineComments } from "../../comments/dist/index.js"
import { createCommentsHandler, defineCommentsPlugin } from "../../comments/dist/runtime/index.js"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { consoleOperationRegistry, installConsoleOperations } from "../src/console/runtime/server/operation-contributions.ts"
import { installConsolePill } from "../src/console/runtime/server/pill.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import siteAccessRoute from "../src/console/runtime/server/site.ts"
import { consoleEntryRoute, siteEntryPage, siteEntryRoute } from "../src/console/runtime/server/site-entry.ts"
import { consoleRoutes } from "../src/console/runtime/server/routes.ts"
import { readConsoleSiteVisitor } from "../src/console/runtime/server/site-visitor.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { SiteTokenClaims } from "@vite-hub/internal/site-token"
import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"

const origin = "http://localhost:5173"
const ada: ConsoleCallerUser = { email: "ada@example.com", id: "console-ada", name: "Ada" }
const key = await consoleTestKey("CONSOLE_SITE")
const other = await consoleTestKey("CONSOLE_OTHER")

function setCookies(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.getSetCookie().map((line) => {
    const pair = line.split(";")[0]!
    const at = pair.indexOf("=")
    return [pair.slice(0, at), line]
  }))
}

function cookieValue(line: string | undefined): string {
  const pair = (line ?? "").split(";")[0]!
  return pair.slice(pair.indexOf("=") + 1)
}

async function startVisit(page = "/docs", base = ""): Promise<{ response: Response, state: string, location: URL }> {
  const response = await siteAccessRoute.fetch(new Request(`${origin}${base}/_vitehub/site?${new URLSearchParams({ return: page })}`))
  return { response, state: cookieValue(setCookies(response)["__Host-vitehub-site-state"]), location: new URL(response.headers.get("location") ?? "", origin) }
}

async function token(state: string, claims: Partial<Omit<SiteTokenClaims, "iat" | "exp">> = {}, options: { now?: number, signer?: typeof key.key } = {}): Promise<string> {
  return await signSiteToken({
    key: options.signer ?? key.key,
    claims: { aud: origin, sub: "console-ada", name: "Ada", email: "ada@example.com", roles: ["console", "comments-write"], kind: "site", path: "/docs?tab=1", state: await siteStateHash(state), ...claims },
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

async function finish(value: string, state: string, base = ""): Promise<Response> {
  return await siteAccessRoute.fetch(new Request(`${origin}${base}/_vitehub/site?${new URLSearchParams({ token: value })}`, { headers: { cookie: `__Host-vitehub-site-state=${state}` } }))
}

async function signIn(claims: Partial<Omit<SiteTokenClaims, "iat" | "exp">> = {}): Promise<string> {
  const { state } = await startVisit()
  const response = await finish(await token(state, claims), state)
  expect(response.status).toBe(303)
  return `__Host-vitehub-site=${cookieValue(setCookies(response)["__Host-vitehub-site"])}`
}

beforeEach(() => {
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
  installConsoleAccess({ mode: "token" })
  installConsoleSections("console-site", ["site", "logs"])
  registerViteHubPageTool({}, {
    id: "comments",
    label: "Comments",
    icon: "i-lucide-message-square-text",
    script: "/comments.js",
    grants: [{ id: "comments-read", label: "Read comments" }, { id: "comments-write", label: "Write comments", description: "Write and reply." }],
    allowed: async () => true,
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
  installConsoleDevelopment("/app", false)
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("GET /_vitehub/site?return=", () => {
  it("uses the configured Console for app visits and the signed issuer for handoffs", async () => {
    vi.stubGlobal("__VITEHUB_CONSOLE_URL__", "https://self-hosted.example.com")
    expect((await startVisit()).location.origin).toBe("https://self-hosted.example.com")
    const app = `${origin}/portal`
    const issuer = "https://console.vitehub.dev"
    const url = await signSiteHandoff({ app, issuer, project: "hosted-project", path: "/docs?tab=1", key: key.key })
    expect(url).toBeDefined()
    const response = await siteAccessRoute.fetch(new Request(url!))
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get("location")!)
    const state = cookieValue(setCookies(response)["__Host-vitehub-site-state"])
    expect(`${location.origin}${location.pathname}`).toBe(`${issuer}/visit`)
    expect(Object.fromEntries(location.searchParams)).toEqual({ app, project: "hosted-project", return: "/docs?tab=1", state: await siteStateHash(state) })

    for (const [name, value] of [["issuer", "https://other.example.com"], ["project", "other-project"], ["return", "/other"]] as const) {
      const tampered = new URL(url!)
      tampered.searchParams.set(name, value)
      expect((await siteAccessRoute.fetch(new Request(tampered))).status).toBe(400)
    }
    expect((await siteAccessRoute.fetch(new Request(`${app}/_vitehub/site?issuer=${encodeURIComponent(issuer)}`))).status).toBe(400)
  })

  it("keeps a state in a cookie and sends the browser to the Console visit URL with the hash of the state", async () => {
    const { response, state, location } = await startVisit("/docs?tab=1")
    expect(response.status).toBe(303)
    expect(state).toMatch(/^[\w-]{43}$/)
    expect(setCookies(response)["__Host-vitehub-site-state"]).toBe(`__Host-vitehub-site-state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`)
    expect(`${location.origin}${location.pathname}`).toBe("https://console.vitehub.dev/visit")
    expect(Object.fromEntries(location.searchParams)).toEqual({ app: origin, state: await siteStateHash(state), return: "/docs?tab=1" })
  })

  it("keeps the state of this browser, so the visit of another tab still ends here", async () => {
    const first = await startVisit()
    const again = await siteAccessRoute.fetch(new Request(`${origin}/_vitehub/site?return=/`, { headers: { cookie: `__Host-vitehub-site-state=${first.state}` } }))
    expect(cookieValue(setCookies(again)["__Host-vitehub-site-state"])).toBe(first.state)
  })

  it("names the app with its base, and refuses a return that is not a path of the app", async () => {
    const { location } = await startVisit("/runs/42", "/portal")
    expect(location.searchParams.get("app")).toBe(`${origin}/portal`)
    for (const page of ["//evil.example/x", "https://evil.example/", "/\\evil.example"]) {
      expect((await startVisit(page)).response.status, page).toBe(400)
    }
  })
})

describe("GET /_vitehub/site?token=", () => {
  it("keeps a good token in the site cookie for 12 hours and opens the page with the pill", async () => {
    const { state } = await startVisit()
    const value = await token(state)
    const response = await finish(value, state)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${origin}/docs?tab=1&vitehub`)
    const cookies = setCookies(response)
    expect(cookies["__Host-vitehub-site"]).toMatch(new RegExp(`^__Host-vitehub-site=${state}\\.${value.replaceAll(".", "\\.")}; Path=/; Max-Age=(4319[0-9]|43200); HttpOnly; Secure; SameSite=Lax$`))
    expect(cookies["__Host-vitehub-site-state"]).toMatch(/^__Host-vitehub-site-state=; .*Max-Age=0/)
    expect(cookies.vitehub_session).toMatch(/^vitehub_session=1; /)
  })

  it.each([
    ["a token for the state of another browser", async (state: string) => ({ value: await token(state, { state: await siteStateHash("x".repeat(43)) }), state })],
    ["a token without the state cookie", async (state: string) => ({ value: await token(state), state: "" })],
    ["an expired token", async (state: string) => ({ value: await token(state, {}, { now: Date.now() - 61_000 }), state })],
    ["a token for another app", async (state: string) => ({ value: await token(state, { aud: "https://evil.example" }), state })],
    ["a token of an unknown key", async (state: string) => ({ value: await token(state, {}, { signer: other.key }), state })],
  ])("refuses %s with 401 and sets no cookie", async (_name, make) => {
    const visit = await startVisit()
    const { value, state } = await make(visit.state)
    const response = await finish(value, state)
    expect(response.status).toBe(401)
    expect(await response.text()).toContain("CONSOLE_SITE_TOKEN_REFUSED")
    expect(response.headers.getSetCookie()).toEqual([])
  })
})

describe("the site cookie", () => {
  it("names the person of the token, a member with the console role and a guest without it", async () => {
    const member = await signIn()
    expect(await readConsoleSiteVisitor(new Request(`${origin}/docs`, { headers: { cookie: member } }))).toEqual({ id: "console-ada", name: "Ada", email: "ada@example.com", roles: ["console", "comments-write"], kind: "member" })
    const guest = await signIn({ sub: "guest-1", name: "Ana", email: undefined, roles: ["comments-write"] })
    expect(await readConsoleSiteVisitor(new Request(`${origin}/docs`, { headers: { cookie: guest } }))).toMatchObject({ id: "guest-1", roles: ["comments-write"], kind: "guest" })
  })

  it("gives a member only new grants from the request app's current tools", async () => {
    const member = await signIn({ roles: ["console"] })
    const app = { async fetch(request: Request) { return Response.json((await viteHubSiteVisitorReader()?.(request))?.roles) } }
    installViteHubPageTools(app)
    installConsolePill(app, { version: "0.4.0", useCurrentGrants: true })
    const tool = { id: "review", label: "Review", icon: "i-lucide-eye", script: "/review.js", allowed: async () => true }
    registerViteHubPageTool(app, { ...tool, grants: [{ id: "review-read", label: "Read reviews" }] })
    registerViteHubPageTool(app, { ...tool, grants: [{ id: "review-write", label: "Write reviews" }] })
    registerViteHubPageTool({}, { ...tool, grants: [{ id: "other-app", label: "Other app" }] })
    const request = new Request(`${origin}/docs`, { headers: { cookie: member } })
    expect(await (await app.fetch(request)).json()).toEqual(["console", "review-write"])
  })

  it("keeps signed Comments API permissions when only the overlay is disabled", async () => {
    const cookie = await signIn({ roles: ["console", "comments-read", "comments-write", "comments-resolve", "comments-delete"] })
    const comments = defineComments()
    for (const overlay of ["/comments.js", false] as const) {
      Reflect.deleteProperty(globalThis, Symbol.for("vitehub.page-tools"))
      const app = createCommentsHandler({ comments, realtime: false })
      defineCommentsPlugin({
        comments,
        overlay,
        database: () => undefined,
        ...(overlay ? { pillSegments: [app => installConsolePill(app, { version: "0.4.0", useCurrentGrants: true })] } : { siteVisitor: readConsoleSiteVisitor }),
      })(app)
      const response = await app.fetch(new Request(`${origin}/_vitehub/comments/session`, { headers: { cookie } }))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ data: { can: { read: true, comment: true, resolve: true, delete: true } } })
    }
  })

  it("keeps the signed roles of a member and a guest when console.authorize may limit the grants", async () => {
    installConsoleAccess({ mode: "token", authorize: () => ({ sections: ["site:read"], grants: ["comments-read"] }) })
    const member = await signIn({ roles: ["console", "comments-read"] })
    const guest = await signIn({ sub: "guest-1", name: "Ana", email: undefined, roles: ["comments-write"] })
    for (const useCurrentGrants of [false, true]) {
      const app = { async fetch(request: Request) { return Response.json((await viteHubSiteVisitorReader()?.(request))?.roles) } }
      installViteHubPageTools(app)
      installConsolePill(app, { version: "0.4.0", useCurrentGrants })
      registerViteHubPageTool(app, { id: "review", label: "Review", icon: "i-lucide-eye", script: "/review.js", allowed: async () => true, grants: [{ id: "review-write", label: "Write reviews" }] })
      if (!useCurrentGrants) expect(await (await app.fetch(new Request(`${origin}/docs`, { headers: { cookie: member } }))).json()).toEqual(["console", "comments-read"])
      expect(await (await app.fetch(new Request(`${origin}/docs`, { headers: { cookie: guest } }))).json()).toEqual(["comments-write"])
    }
  })

  it("ends 12 hours after the Console signed the token, and after the key of the link is gone", async () => {
    const cookie = await signIn()
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Date.now() + 12 * 60 * 60 * 1_000)
    expect(await readConsoleSiteVisitor(new Request(`${origin}/docs`, { headers: { cookie } }))).toBeUndefined()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    for (const [name, value] of Object.entries(other.env)) vi.stubEnv(name, value)
    expect(await readConsoleSiteVisitor(new Request(`${origin}/docs`, { headers: { cookie } }))).toBeUndefined()
  })

  it("signs the browser out with a POST from a page of the app", async () => {
    const response = await siteAccessRoute.fetch(new Request(`${origin}/_vitehub/site`, { method: "POST", headers: { "sec-fetch-site": "same-origin" } }))
    expect(response.status).toBe(204)
    expect(setCookies(response)["__Host-vitehub-site"]).toMatch(/^__Host-vitehub-site=; .*Max-Age=0/)
    expect((await siteAccessRoute.fetch(new Request(`${origin}/_vitehub/site`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403)
  })

  it("signs out without Sec-Fetch-Site only for the Origin of the app", async () => {
    const signOut = async (headers: Record<string, string>) => (await siteAccessRoute.fetch(new Request(`${origin}/_vitehub/site`, { method: "POST", headers }))).status
    expect(await signOut({ origin })).toBe(204)
    expect(await signOut({})).toBe(403)
    expect(await signOut({ origin: "null" })).toBe(403)
    expect(await signOut({ origin: "https://evil.example" })).toBe(403)
    expect(await signOut({ "sec-fetch-site": "same-site", origin })).toBe(403)
  })

  it("marks guest accounts and gives the Console segment to members only", async () => {
    const nitroApp = {}
    installConsolePill(nitroApp, { version: "0.4.0" })
    registerViteHubPageTool(nitroApp, { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/comments.js", allowed: async () => true })
    const session = async (cookie = "") => readViteHubPageSession(await (await respondViteHubPageSession(nitroApp, new Request(`${origin}/_vitehub/page/tools`, { headers: { cookie } }))).json())
    const member = await session(await signIn())
    expect(member.tools.map(tool => tool.id)).toEqual(["console", "comments"])
    expect(member.account).toEqual({ name: "Ada", email: "ada@example.com", via: "console", signOut: "/_vitehub/site" })
    const guest = await session(await signIn({ name: "Ana", roles: ["comments-write"] }))
    expect(guest.tools.map(tool => tool.id)).toEqual(["comments"])
    expect(guest.account).toEqual({ name: "Ana", via: "console", guest: true, signOut: "/_vitehub/site" })
    expect(await session()).toEqual({ tools: [expect.objectContaining({ id: "comments" })] })
  })
})

describe("GET /_vitehub in an app with Comments", () => {
  async function enter(path = "/_vitehub", headers: Record<string, string> = {}): Promise<Response> {
    return await siteEntryRoute.fetch(new Request(`${origin}${path}`, { headers }))
  }

  it("sends a visitor without Site access to /_vitehub/site with the page of the Referer", async () => {
    const response = await enter("/_vitehub", { referer: `${origin}/runs/42?tab=logs` })
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`/_vitehub/site?${new URLSearchParams({ return: "/runs/42?tab=logs" })}`)
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it("comes back to the path below /_vitehub and the app base", async () => {
    expect((await enter("/_vitehub/projects/meetups?task=x")).headers.get("location")).toBe(`/_vitehub/site?${new URLSearchParams({ return: "/projects/meetups?task=x" })}`)
    expect((await enter("/portal/_vitehub/runs/42")).headers.get("location")).toBe(`/portal/_vitehub/site?${new URLSearchParams({ return: "/runs/42" })}`)
  })

  it("goes to the page with the pill at once for a browser with a good site cookie, and on a development server", async () => {
    const open = async (cookie: string) => (await enter("/_vitehub/docs", { cookie })).headers.get("location")
    expect(await open(await signIn())).toBe("/docs?vitehub")
    expect(await open(await signIn({ roles: ["comments-write"] }))).toBe("/docs?vitehub")
    const { state } = await startVisit()
    expect(await open(`__Host-vitehub-site=${state}.${await token(state, { aud: `${origin}/portal` })}`)).toMatch(/^\/_vitehub\/site\?/)
    expect(await open("__Host-vitehub-site=forged")).toMatch(/^\/_vitehub\/site\?/)
    installConsoleDevelopment("", true)
    expect((await enter("/_vitehub/docs?tab=1")).headers.get("location")).toBe("/docs?tab=1&vitehub")
  })

  it("answers 404 for a path that ViteHub serves itself", async () => {
    for (const path of ["/_vitehub/rpc/x", "/_vitehub/site/x", "/_vitehub/page/assets/old.js", "/_vitehub/_vitehub/runs"]) {
      const response = await enter(path)
      expect(response.status, path).toBe(404)
      expect(response.headers.get("location"), path).toBeNull()
    }
  })

  it.each([
    [null, "/"],
    ["/guide/day-2", "/guide/day-2"],
    ["//evil.example/x", "/"],
    ["https://evil.example/", "/"],
    ["/\\evil.example", "/"],
    ["/\t/evil.example", "/"],
    ["/_vitehub/rpc", "/"],
  ])("reads %s as the page %s", (page, path) => {
    expect(siteEntryPage(page, "")).toBe(path)
  })

  it("answers only on the public URL, so another hostname of the deployment gets 404", async () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://drop.example.com" })
    expect((await siteEntryRoute.fetch(new Request("https://drop.example.com/_vitehub/d/report"))).status).toBe(303)
    expect((await siteEntryRoute.fetch(new Request("https://abc-drop.example.com/_vitehub"))).status).toBe(404)
    expect((await siteAccessRoute.fetch(new Request("https://abc-drop.example.com/_vitehub/site?return=/"))).status).toBe(404)
  })
})

describe("GET /_vitehub in an app without Comments", () => {
  async function enter(path = "/_vitehub", init: RequestInit = {}, base = origin): Promise<Response> {
    return await consoleEntryRoute.fetch(new Request(`${base}${path}`, init))
  }

  it("sends the browser to the app in the ViteHub Console", async () => {
    const response = await enter()
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://console.vitehub.dev/open?project=http%3A%2F%2Flocalhost%3A5173&path=%2F")
    expect(response.headers.getSetCookie()).toEqual([])
  })

  it("opens the Console page below /_vitehub, with its query, for the app at its base", async () => {
    const location = async (path: string) => new URL((await enter(path)).headers.get("location") ?? "")
    const page = await location("/_vitehub/agents/bot?tab=trace")
    expect(page.origin).toBe("https://console.vitehub.dev")
    expect(Object.fromEntries(page.searchParams)).toEqual({ project: origin, path: "/agents/bot?tab=trace" })
    expect(Object.fromEntries((await location("/portal/_vitehub/runs/42")).searchParams)).toEqual({ project: `${origin}/portal`, path: "/runs/42" })
    expect(Object.fromEntries((await location("/_vitehub/_vitehub/runs")).searchParams)).toEqual({ project: origin, path: "/runs" })
  })

  it("goes to the Console also with a good site cookie", async () => {
    const response = await enter("/_vitehub/docs", { headers: { cookie: await signIn() } })
    expect(new URL(response.headers.get("location") ?? "").origin).toBe("https://console.vitehub.dev")
  })

  it("answers 404 for an app origin that the Console cannot open", async () => {
    installConsoleDevelopment("", true)
    expect((await enter("/_vitehub", {}, "http://192.168.0.38:3000")).status).toBe(404)
  })

  it("opens the Console only with GET and HEAD", async () => {
    expect((await enter("/_vitehub", { method: "POST" })).status).toBe(405)
    expect((await enter("/_vitehub/rpc/x", { method: "POST" })).status).toBe(404)
    expect((await enter("/_vitehub", { method: "HEAD" })).status).toBe(303)
  })

  it("answers only on the public URL, so another hostname of the deployment gets 404", async () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://drop.example.com" })
    expect((await consoleEntryRoute.fetch(new Request("https://drop.example.com/_vitehub/d/report"))).status).toBe(303)
    expect((await consoleEntryRoute.fetch(new Request("https://abc-drop.example.com/_vitehub"))).status).toBe(404)
  })
})

describe("the /_vitehub/** route", () => {
  it("serves Site access at /_vitehub/site only in an app with Comments", async () => {
    const withComments = consoleRoutes({ siteAccess: true })
    const withoutComments = consoleRoutes({ siteAccess: false })
    const site = await withComments.fetch(new Request(`${origin}/_vitehub/site?return=%2Fdocs`))
    expect(new URL(site.headers.get("location") ?? "").pathname).toBe("/visit")
    expect(site.headers.get("set-cookie")).toMatch(/__Host-vitehub-site-state=/)
    expect((await withoutComments.fetch(new Request(`${origin}/_vitehub/site?return=%2Fdocs`))).status).toBe(404)
    expect((await withoutComments.fetch(new Request(`${origin}/portal/_vitehub/site`))).status).toBe(404)
    expect((await withComments.fetch(new Request(`${origin}/_vitehub/site`, { method: "POST", headers: { origin } }))).status).toBe(204)
    expect((await withoutComments.fetch(new Request(`${origin}/_vitehub/site`, { method: "POST", headers: { origin } }))).status).toBe(404)
  })

  it("sends /_vitehub/rpc to the Console RPC and every other path to the entry", async () => {
    for (const routes of [consoleRoutes({ siteAccess: true }), consoleRoutes({ siteAccess: false })]) {
      expect((await routes.fetch(new Request(`${origin}/portal/_vitehub/rpc`, { method: "PUT" }))).status).toBe(401)
      expect((await routes.fetch(new Request(`${origin}/_vitehub/docs`))).status).toBe(303)
    }
  })
})

describe("site.access", () => {
  async function call(name: string, user: ConsoleCallerUser = ada) {
    const response = await handleConsoleRpcRequest(await signedRpcRequest({ caller: { user, via: "console" }, input: {}, key: key.key, operation: name, url: `${origin}/_vitehub/rpc` }))
    const body: unknown = await operationRpcResponseResult(response)
    return { status: response.status, value: Reflect.get(Object(body), "value") }
  }

  it("is listed in project.get, and gives the page tool roles of the app", async () => {
    expect(Reflect.get(Object((await call("project.get")).value), "operations")).toContain("site.access")
    expect((await call("site.access")).value).toEqual({
      write: true,
      roles: [{ id: "comments-read", label: "Read comments" }, { id: "comments-write", label: "Write comments", description: "Write and reply." }],
    })
  })

  it("gives only the roles that console.authorize grants, read-only without site write", async () => {
    installConsoleAccess({ mode: "token", authorize: () => ({ sections: ["site:read"], grants: ["comments-read"] }) })
    expect((await call("site.access")).value).toEqual({ write: false, roles: [{ id: "comments-read", label: "Read comments" }] })
  })

  it("is not registered in an app without Comments, so Agent operations() and the RPC do not have it", async () => {
    installConsoleSections("console-site", ["logs"])
    installConsoleOperations([], { site: false })
    try {
      expect(consoleOperationRegistry().list().map(operation => operation.name)).not.toContain("site.access")
      expect(Reflect.get(Object((await call("project.get")).value), "operations")).not.toContain("site.access")
      expect((await call("site.access")).status).toBe(404)
    }
    finally {
      installConsoleOperations([])
    }
  })
})
