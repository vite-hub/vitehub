import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { runViteHubCli } from "@vite-hub/cli"
import { registerViteHubPageTool, respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"
import { readViteHubPageSession } from "@vite-hub/internal/runtime/page-tools-shared"

import { createAuthConsole } from "../../auth/src/console-runtime.ts"
import { consoleEventsFixture } from "../../auth/test/fixtures/console-events.ts"
import { commentsRoleAllows } from "../../comments/src/index.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { consoleOperations } from "../src/console/runtime/server/operations.ts"
import { installConsoleProjectRoot } from "../src/console/runtime/server/project-root.ts"
import { redeemConsoleTicket } from "../src/console/runtime/server/tickets.ts"
import { consolePageAuthUser } from "../src/console/runtime/server/page-auth.ts"
import { consolePageToolAllowed, installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import consoleRpcRoute from "../src/console/runtime/server/rpc.ts"
import siteEntryRoute, { siteEntryPage } from "../src/console/runtime/server/site-entry.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { requestEvent } from "./console-event.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { AuthConsoleHostOptions } from "../../auth/src/console-types.ts"
import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"

type Fixture = Awaited<ReturnType<typeof consoleEventsFixture>>
const state = vi.hoisted(() => ({ app: undefined as undefined | { auth: unknown, create: (host: unknown) => unknown } }))
vi.mock("@vite-hub/auth/server", async importOriginal => ({
  ...(await importOriginal<typeof import("@vite-hub/auth/server")>()),
  getAuthConsoleForRequest: (_request: Request, _event: unknown, host: unknown) => state.app?.create(host),
  useAuth: () => state.app?.auth,
}))

const origin = "http://localhost:5173"
const ada: ConsoleCallerUser = { email: "Ada@Example.com", id: "console-ada", name: "Ada" }
const key = await consoleTestKey("CONSOLE_SITE")
const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
let app: Fixture

async function call(name: string, input: Record<string, unknown> = {}, user: ConsoleCallerUser = ada): Promise<{ status: number, value: unknown, body: unknown }> {
  const response = await handleConsoleRpcRequest(await signedRpcRequest({ caller: { user, via: "console" }, input, key: key.key, operation: name, url: `${origin}/_vitehub/rpc` }))
  const body: unknown = await operationRpcResponseResult(response)
  return { status: response.status, value: Reflect.get(Object(body), "value"), body }
}

async function link(name: string, input: Record<string, unknown> = {}, user?: ConsoleCallerUser): Promise<string> {
  const { value, body } = await call(name, input, user)
  const url: unknown = Reflect.get(Object(value), "url")
  if (String(url) !== url) throw new Error(`No link: ${JSON.stringify(body)}`)
  return url
}

/** Opens a one-time link in a browser, and returns the redirect and the cookies it set, as a Cookie header. */
async function open(url: string, userAgent = chrome, cookies = ""): Promise<{ response: Response, cookie: string }> {
  const response = await consoleRpcRoute.fetch(new Request(url, { headers: { "user-agent": userAgent, ...(cookies ? { cookie: cookies } : {}) } }))
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]!).filter(pair => !pair.endsWith("=")).join("; ")
  return { response, cookie }
}

async function signedIn(cookie: string) {
  return await app.auth.api.getSession({ headers: new Headers({ cookie }) })
}

const consoleLink = (cookie: string) => consolePageToolAllowed(new Request(`${origin}/`, { headers: { cookie } }), { user: consolePageAuthUser })

beforeEach(async () => {
  app = await consoleEventsFixture()
  state.app = { auth: app.auth, create: host => createAuthConsole(app.auth, {}, app.store, host as AuthConsoleHostOptions) }
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
  installConsoleSections("console-site-access", ["auth", "site"])
  installConsoleAccess({ mode: "token" })
  registerViteHubPageTool({}, {
    id: "comments",
    label: "Comments",
    icon: "i-lucide-message-square-text",
    script: "/comments.js",
    grants: [{ id: "comments-read", label: "Read comments" }, { id: "comments-write", label: "Write comments" }],
    allowed: async () => true,
  })
})

afterEach(() => {
  app.database.sqlite.close()
  state.app = undefined
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  installConsoleDevelopment("/app", false)
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("Console members", () => {
  it("signs the browser in as the app user with the member's email, with the console role and every page tool role", async () => {
    app.database.sqlite.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").run(app.member.id)
    const url = await link("site.link", { path: "/runs/42" })
    const { response, cookie } = await open(url)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${origin}/runs/42?vitehub`)
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^better-auth\.session_token=[^;]+; Max-Age=604800; Path=\/; HttpOnly; SameSite=Lax$/),
      "vitehub_session=1; Path=/; SameSite=Lax; Max-Age=604800",
      "vitehub-tools=; Path=/; Max-Age=0; SameSite=Lax",
    ])
    expect((await signedIn(cookie))?.user).toMatchObject({ id: app.member.id, email: "ada@example.com", role: "user,console,comments-read,comments-write" })
    expect(await consoleLink(cookie)).toBe(true)
    // The link works once.
    expect((await open(url)).response.status).toBe(401)
  })

  it("makes the app user when the member has none, and lists the browser until it is revoked", async () => {
    const grace: ConsoleCallerUser = { email: "grace@example.com", id: "console-grace", name: "Grace" }
    const { cookie } = await open(await link("site.link", {}, grace))
    expect((await signedIn(cookie))?.user).toMatchObject({ email: "grace@example.com", name: "Grace", role: "console,comments-read,comments-write" })
    const { value } = await call("site.sessions")
    expect(value).toEqual({ sessions: [expect.objectContaining({ kind: "member", person: expect.objectContaining({ email: "grace@example.com", name: "Grace" }), grants: ["console", "comments-read", "comments-write"], device: "Chrome · macOS" })] })
    const id = String(Reflect.get(Object((value as { sessions: unknown[] }).sessions[0]), "id"))
    expect((await call("site.revoke-session", { id })).value).toEqual({ revoked: true, removedUser: false })
    expect(await signedIn(cookie)).toBeNull()
    expect(app.database.sqlite.prepare("SELECT id FROM user WHERE email = ?").get("grace@example.com")).toBeDefined()
  })

  it("refuses an app account with the member's email that nobody verified, and gives it no role", async () => {
    // Anyone can sign up to the app with the member's email. That account must not get the member's roles.
    const { response, cookie } = await open(await link("site.link"))
    expect(response.status).toBe(403)
    expect(await response.text()).toContain("its email is not verified")
    expect(cookie).toBe("")
    expect(app.database.sqlite.prepare("SELECT role FROM user WHERE id = ?").get(app.member.id)).toEqual({ role: "user" })
  })

  it("gives only the page tool roles that console.authorize grants", async () => {
    installConsoleAccess({ mode: "token", authorize: ({ via }) => via === "console" ? { sections: ["site"], grants: ["comments-read"] } : false })
    const grace: ConsoleCallerUser = { email: "grace@example.com", id: "console-grace", name: "Grace" }
    const { cookie } = await open(await link("site.link", {}, grace))
    expect((await signedIn(cookie))?.user).toMatchObject({ email: "grace@example.com", role: "console,comments-read" })
  })

  it("takes back page tool roles that console.authorize no longer grants, and keeps the app's own roles", async () => {
    app.database.sqlite.prepare("UPDATE user SET emailVerified = 1, role = 'user,editor' WHERE id = ?").run(app.member.id)
    await open(await link("site.link"))
    expect(app.database.sqlite.prepare("SELECT role FROM user WHERE id = ?").get(app.member.id)).toEqual({ role: "user,editor,console,comments-read,comments-write" })
    installConsoleAccess({ mode: "token", authorize: () => ({ sections: ["site"], grants: ["comments-read"] }) })
    const { cookie } = await open(await link("site.link"))
    expect((await signedIn(cookie))?.user).toMatchObject({ id: app.member.id, role: "user,editor,console,comments-read" })
  })

  it("refuses grants that no page tool gives, and a person whom console.authorize refuses", async () => {
    installConsoleAccess({ mode: "token", authorize: () => ({ sections: ["site"], grants: ["comments-admin"] }) })
    const { status, body } = await call("site.link")
    expect(status).toBe(500)
    expect(JSON.stringify(body)).toContain("comments-admin")
    installConsoleAccess({ mode: "token", authorize: () => ({ sections: ["content"] }) })
    expect((await call("site.link")).status).toBe(403)
  })

  it("gives a phone link 10 minutes", async () => {
    const { value } = await call("site.link", { qr: true })
    const left = Date.parse(String(Reflect.get(Object(value), "expiresAt"))) - Date.now()
    expect(left).toBeGreaterThan(9 * 60_000)
    expect(left).toBeLessThanOrEqual(10 * 60_000)
  })
})

describe("guests", () => {
  it("signs one browser in as a new user with the name and roles, never the Console", async () => {
    const { value } = await call("site.invite", { name: "Ana", grants: ["comments-write"] })
    const url = String(Reflect.get(Object(value), "url"))
    expect((await call("site.invites")).value).toEqual({ invites: [expect.objectContaining({ name: "Ana", grants: ["comments-write"], path: "/" })] })
    const { response, cookie } = await open(url, iphone)
    expect(response.status).toBe(303)
    const user = (await signedIn(cookie))?.user
    expect(user).toMatchObject({ name: "Ana", role: "guest,comments-write", email: expect.stringMatching(/@guests\.invalid$/) })
    const roles = { id: user!.id, role: String(Reflect.get(user!, "role")) }
    expect([commentsRoleAllows(roles, "read"), commentsRoleAllows(roles, "write"), commentsRoleAllows(roles, "delete")]).toEqual([true, true, false])
    expect(await consoleLink(cookie)).toBe(false)
    // The invite works once, and leaves the list.
    expect((await open(url, chrome)).response.status).toBe(401)
    expect((await call("site.invites")).value).toEqual({ invites: [] })
    const sessions = (await call("site.sessions")).value as { sessions: Array<{ id: string, person: object }> }
    expect(sessions.sessions).toEqual([expect.objectContaining({ kind: "guest", person: { id: user!.id, name: "Ana" }, grants: ["comments-write"], device: "Safari · iOS" })])
    // Revoking the guest's browser deletes the guest.
    expect((await call("site.revoke-session", { id: sessions.sessions[0]!.id })).value).toEqual({ revoked: true, removedUser: true })
    expect(await signedIn(cookie)).toBeNull()
    expect(app.database.sqlite.prepare("SELECT id FROM user WHERE id = ?").get(user!.id)).toBeUndefined()
  })

  it("refuses the console role, unknown roles, and no roles", async () => {
    for (const grants of [["console"], ["comments-admin"], []]) {
      expect((await call("site.invite", { name: "Ana", grants })).status).toBe(400)
    }
    expect((await call("site.grants")).value).toEqual({ grants: [expect.objectContaining({ id: "console", membersOnly: true }), { id: "comments-read", label: "Read comments" }, { id: "comments-write", label: "Write comments" }] })
  })

  it("stops an invite that someone revoked or that expired", async () => {
    const { value } = await call("site.invite", { name: "Ana", grants: ["comments-read"] })
    const id = String(Reflect.get(Object(Reflect.get(Object(value), "invite")), "id"))
    expect((await call("site.revoke-invite", { id })).value).toEqual({ revoked: true })
    expect((await open(String(Reflect.get(Object(value), "url")))).response.status).toBe(401)

    const late = String(Reflect.get(Object((await call("site.invite", { name: "Leo", grants: ["comments-read"], expiresInDays: 1 })).value), "url"))
    vi.useFakeTimers({ now: Date.now() + 25 * 60 * 60_000, toFake: ["Date"] })
    expect((await open(late)).response.status).toBe(401)
  })
})

describe("GET /_vitehub", () => {
  async function enter(path = "/_vitehub", headers: Record<string, string> = {}): Promise<{ response: Response, location: URL, state: string, cookie: string }> {
    const response = await siteEntryRoute.fetch(new Request(`${origin}${path}`, { headers }))
    const location = new URL(response.headers.get("location") ?? "", origin)
    const cookie = response.headers.getSetCookie()[0] ?? ""
    return { response, location, state: location.searchParams.get("state") ?? "", cookie }
  }

  it("sends the browser to the Console with the page of the Referer and a state, and keeps the state in a cookie", async () => {
    const { response, location, state, cookie } = await enter("/_vitehub", { referer: `${origin}/runs/42?tab=logs` })
    expect(response.status).toBe(303)
    expect(`${location.origin}${location.pathname}`).toBe("https://console.vitehub.dev/open")
    expect(Object.fromEntries(location.searchParams)).toEqual({ project: origin, site: "/runs/42?tab=logs", state })
    expect(state).toMatch(/^[\w-]{43}$/)
    expect(cookie).toBe(`__Host-vitehub-site-state=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`)
  })

  it("comes back to the path below /_vitehub, with its query", async () => {
    const { location } = await enter("/_vitehub/projects/meetups?task=x", { referer: `${origin}/elsewhere` })
    expect(location.searchParams.get("site")).toBe("/projects/meetups?task=x")
  })

  it.each([
    ["/_vitehub", {}, "/"],
    ["/_vitehub/", {}, "/"],
    ["/_vitehub", { referer: "https://evil.example/runs/42" }, "/"],
    ["/_vitehub", { referer: `${origin}/_vitehub/rpc` }, "/"],
    ["/_vitehub//evil.example/x", {}, "/"],
  ])("comes back from %s with %o to %s, a page of the app", async (path, headers, site) => {
    const { location } = await enter(path, headers)
    expect(location.origin).toBe("https://console.vitehub.dev")
    expect(location.searchParams.get("site")).toBe(site)
  })

  it("answers 404 for a path that ViteHub serves itself, and goes to no page", async () => {
    for (const path of ["/_vitehub/rpc/x", "/_vitehub/page/assets/old.js", "/_vitehub/.well-known/skills/x", "/_vitehub/_vitehub/runs"]) {
      const response = await siteEntryRoute.fetch(new Request(`${origin}${path}`))
      expect(response.status, path).toBe(404)
      expect(response.headers.get("location"), path).toBeNull()
    }
  })

  it("signs in only the browser that has the state cookie, and goes back to the page with the pill", async () => {
    app.database.sqlite.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").run(app.member.id)
    const { state, cookie, location } = await enter("/_vitehub/projects/meetups?task=x")
    const stateCookie = cookie.split(";")[0]!
    // The Console calls site.link with the page and the state of the link, as for a signed-out person after the sign-in.
    const input = { path: location.searchParams.get("site"), state }

    // A link made for another browser's state signs nobody in here.
    const stolen = await open(await link("site.link", input))
    expect(stolen.response.status).toBe(403)
    expect(stolen.cookie).toBe("")

    const { response, cookie: session } = await open(await link("site.link", input), chrome, stateCookie)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${origin}/projects/meetups?task=x&vitehub`)
    expect((await signedIn(session))?.user).toMatchObject({ id: app.member.id })

    // Signed in now, /_vitehub goes back to the page at once.
    const nitroApp = { fetch: (request: Request) => siteEntryRoute.fetch(request) }
    installConsolePageTool(nitroApp, { script: "/console.js", user: consolePageAuthUser })
    const again = await nitroApp.fetch(new Request(`${origin}/_vitehub/projects/meetups?task=x`, { headers: { cookie: session } }))
    expect(again.headers.get("location")).toBe("/projects/meetups?task=x&vitehub")
    // Without the session, it still goes through the Console.
    const anonymous = await nitroApp.fetch(new Request(`${origin}/_vitehub/projects/meetups`))
    expect(new URL(anonymous.headers.get("location")!).origin).toBe("https://console.vitehub.dev")
  })

  it("keeps the state of this browser, so a link from another tab still works", async () => {
    const first = await enter()
    const response = await siteEntryRoute.fetch(new Request(`${origin}/_vitehub`, { headers: { cookie: first.cookie.split(";")[0]! } }))
    expect(new URL(response.headers.get("location")!).searchParams.get("state")).toBe(first.state)
  })

  it("goes to the page with ?vitehub on a development server", async () => {
    installConsoleDevelopment("", true)
    const { response, cookie } = await enter("/_vitehub/docs?tab=1")
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("/docs?tab=1&vitehub")
    expect(cookie).toBe("")
    expect((await enter("/_vitehub", { referer: `${origin}/docs?vitehub=comments` })).response.headers.get("location")).toBe("/docs?vitehub=comments")
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

  it("reads the page below the app base", async () => {
    expect(siteEntryPage("/portal/runs/42?x=1", "/portal")).toBe("/runs/42?x=1")
    expect(siteEntryPage("/portal", "/portal")).toBe("/")
    expect(siteEntryPage("/portality", "/portal")).toBe("/")
    expect(siteEntryPage("/runs/42", "/portal")).toBe("/")
    const { location } = await enter("/portal/_vitehub/runs/42")
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ project: `${origin}/portal`, site: "/runs/42" })
  })

  it("answers only on the public URL, so another hostname of the deployment gets 404", async () => {
    vi.stubGlobal("__VITEHUB_PUBLIC_URL__", { url: "https://drop.example.com" })
    try {
      const own = await siteEntryRoute.fetch(new Request("https://drop.example.com/_vitehub/d/report"))
      expect(own.status).toBe(303)
      expect(new URL(own.headers.get("location")!).searchParams.get("project")).toBe("https://drop.example.com")
      for (const url of ["https://abc-drop.example.com/_vitehub", "https://abc-drop.example.com/_vitehub/d/report"]) {
        const response = await siteEntryRoute.fetch(new Request(url))
        expect(response.status, url).toBe(404)
        expect(response.headers.get("location"), url).toBeNull()
      }
      // A development server answers on every origin.
      installConsoleDevelopment("", true)
      expect((await siteEntryRoute.fetch(new Request("https://abc-drop.example.com/_vitehub"))).status).toBe(303)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it("answers only GET, and 404 for another method on a page path", async () => {
    expect((await siteEntryRoute.fetch(new Request(`${origin}/_vitehub`, { method: "POST" }))).status).toBe(405)
    expect((await siteEntryRoute.fetch(new Request(`${origin}/_vitehub/schedules/run`, { method: "POST" }))).status).toBe(404)
  })
})

describe("the account in the pill", () => {
  /** An app with the Console link and Comments for every reader, as generated output installs them with Auth. */
  function pageApp(): object {
    const nitroApp = {}
    installConsolePageTool(nitroApp, { script: "/console.js", user: consolePageAuthUser })
    registerViteHubPageTool(nitroApp, {
      id: "comments",
      label: "Comments",
      icon: "i-lucide-message-square-text",
      script: "/comments.js",
      allowed: async ({ request }) => {
        const user = (await signedIn(request.headers.get("cookie") ?? ""))?.user
        return Boolean(user && commentsRoleAllows({ id: user.id, role: String(Reflect.get(user, "role")) }, "read"))
      },
    })
    return nitroApp
  }

  async function pageSession(nitroApp: object, cookie = "") {
    const response = await respondViteHubPageSession(nitroApp, new Request(`${origin}/_vitehub/page/session`, { headers: { cookie } }))
    return readViteHubPageSession(await response.json())
  }

  it("names a Console member, says the Console signed them in, and signs them out of the app only", async () => {
    app.database.sqlite.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").run(app.member.id)
    const nitroApp = pageApp()
    const { response: opened, cookie } = await open(await link("site.link"))
    expect(opened.status).toBe(303)
    const { tools, account } = await pageSession(nitroApp, cookie)
    expect(tools.map(tool => tool.id)).toEqual(["console", "comments"])
    expect(account).toEqual({ name: "Ada Lovelace", email: "ada@example.com", via: "console", signOut: "/api/auth/sign-out" })

    // The browser posts to signOut, as the account menu does.
    const response = await app.auth.handler(new Request(`${origin}${account!.signOut}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: "{}" }))
    expect(response.status).toBe(200)
    const cleared = response.headers.getSetCookie()
    expect(cleared).toEqual(expect.arrayContaining([
      expect.stringMatching(/^better-auth\.session_token=; .*Max-Age=0/),
      expect.stringMatching(/^vitehub_session=; .*Max-Age=0/),
      "vitehub-tools=; Path=/; Max-Age=0; SameSite=Lax",
    ]))
    expect(await signedIn(cookie)).toBeNull()
    expect(await pageSession(nitroApp, cookie)).toEqual({ tools: [] })
  })

  it("names a guest without the made-up email, and without the Console line", async () => {
    const nitroApp = pageApp()
    const { value } = await call("site.invite", { name: "Ana", grants: ["comments-write"] })
    const { cookie } = await open(String(Reflect.get(Object(value), "url")))
    const { tools, account } = await pageSession(nitroApp, cookie)
    expect(tools.map(tool => tool.id)).toEqual(["comments"])
    expect(account).toEqual({ name: "Ana", signOut: "/api/auth/sign-out" })
  })

  it("never names anyone to an anonymous visitor", async () => {
    installConsoleAccess({ mode: "open" })
    const nitroApp = {}
    installConsolePageTool(nitroApp, { script: "/console.js", user: consolePageAuthUser })
    registerViteHubPageTool(nitroApp, { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "/comments.js", allowed: async () => true })
    expect(await pageSession(nitroApp)).toEqual({ tools: [expect.objectContaining({ id: "comments" })] })
  })
})

/**
 * Run `vitehub <args>` as in a project with the Console. Its calls reach the Console RPC of this app: signed with a key
 * and `--url`, as against a deployed app, or unsigned through the dev server that the command finds.
 */
async function vitehub(args: string[], target: "deployed" | "dev" = "deployed") {
  let stdout = ""
  let stderr = ""
  const plugin = { name: "vite-hub", vitehub: { operations: [{ export: "consoleOperations", load: async () => consoleOperations, module: "vite-hub/console/server" }] } }
  const code = await runViteHubCli({
    args: target === "deployed" ? [...args, "--url", origin] : args,
    cwd: "/app",
    env: target === "deployed" ? { VITEHUB_CONSOLE_PRIVATE_KEY_CONSOLE_SITE: key.key.privateKey } : { VITEHUB_DEV_SERVER_URL: origin },
    fetch: async (url, init) => await handleConsoleRpcRequest(new Request(url, init), { remoteAddress: "127.0.0.1" }),
    loadConfig: async () => ({ plugins: [plugin], root: "/app" }),
    loadNuxtViteConfig: async () => undefined,
    stderr: { write: chunk => (stderr += String(chunk), true) },
    stdout: { write: chunk => (stdout += String(chunk), true) },
  })
  return { code, stderr, stdout }
}

describe("the vitehub site commands", () => {
  it("list the browsers and sign one out", async () => {
    app.database.sqlite.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").run(app.member.id)
    const { response: opened, cookie } = await open(await link("site.link"))
    expect(opened.status).toBe(303)
    const sessions = await vitehub(["site", "sessions"])
    expect(sessions).toMatchObject({ code: 0, stderr: "" })
    const [header, ...rows] = sessions.stdout.trimEnd().split("\n")
    expect(header).toMatch(/^ID +KIND +PERSON +DEVICE +LAST SEEN +EXPIRES$/)
    // The fixture member also has a session of their own, from another device.
    const row = rows.find(line => line.includes("Chrome"))
    expect(row).toMatch(/^\S+ +member +Ada Lovelace <ada@example\.com> +Chrome · macOS +\d{4}-\d\d-\d\dT\S+ +\d{4}-\d\d-\d\dT\S+$/)

    const id = row!.split(/ +/)[0]!
    expect(await vitehub(["site", "revoke", id, "--yes"])).toEqual({ code: 0, stderr: "", stdout: "Signed the browser out.\n" })
    expect(await signedIn(cookie)).toBeNull()
    expect((await vitehub(["site", "sessions"])).stdout).not.toContain("Chrome")
  })

  it("refuse a sign-in link or an invite from a deployed app, and say where to make it", async () => {
    const opened = await vitehub(["site", "open", "/runs/42"])
    expect(opened).toMatchObject({ code: 1, stdout: "" })
    expect(opened.stderr).toContain("CONSOLE_TICKET_NO_PERSON: Opening the site signs the browser in as the app user with the email of the person who asks, and this call names no person. A `vitehub` command signs its calls with a key, not as a person.")
    expect(opened.stderr).toContain("Fix: Make the link in the ViteHub Console, where you are signed in.")

    const invited = await vitehub(["site", "invite", "Ana", "--grants", "comments-write"])
    expect(invited.code).toBe(1)
    expect(invited.stderr).toContain("CONSOLE_TICKET_NO_PERSON: An invite records the Console member who made it")
    expect((await vitehub(["site", "invites"])).stdout).toBe("No open invites.\n")
  })

  it("on a dev server, refuse a sign-in link for the local developer and invite a guest instead", async () => {
    installConsoleAccess({ mode: "local" })
    installConsoleDevelopment("/app", true)
    installConsoleProjectRoot("/app")
    const opened = await vitehub(["site", "open"], "dev")
    expect(opened.code).toBe(1)
    expect(opened.stderr).toContain("CONSOLE_TICKET_NO_PERSON: Opening the site signs the browser in as the app user with your email, and the development server knows you only as the local developer, without an email.")
    expect(opened.stderr).toContain("invite the browser as a guest: `vitehub site invite <name> --grants <role>`")

    const invited = await vitehub(["site", "invite", "Ana", "--grants", "comments-read,comments-write", "--expires-in-days", "1", "--path", "/runs/42"], "dev")
    expect(invited).toMatchObject({ code: 0, stderr: "" })
    const [url, note] = invited.stdout.trimEnd().split("\n")
    expect(url).toMatch(new RegExp(`^${origin}/_vitehub/rpc\\?ticket=vt1_`))
    expect(note).toMatch(/^The link works once, in one browser, until \S+\. Revoke it with `vitehub site revoke-invite \S+`\.$/)
    const invites = await vitehub(["site", "invites"], "dev")
    expect(invites.stdout).toMatch(/^ID +NAME +ROLES +PATH +EXPIRES +BY\n\S+ +Ana +comments-read,comments-write +\/runs\/42 +\S+ +You\n$/)

    // A development server answers only this machine, so the browser that opens the link runs here too.
    const response = await redeemConsoleTicket(requestEvent(new Request(url!, { headers: { "user-agent": chrome } }), { remoteAddress: "127.0.0.1" }))
    const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]!).filter(pair => !pair.endsWith("=")).join("; ")
    expect(response.headers.get("location")).toBe(`${origin}/runs/42?vitehub`)
    expect((await signedIn(cookie))?.user).toMatchObject({ name: "Ana", role: "guest,comments-read,comments-write" })
    expect((await vitehub(["site", "grants"], "dev")).stdout).toBe([
      "ROLE            LABEL           GUESTS",
      "console         Console         no, members only",
      "comments-read   Read comments   yes",
      "comments-write  Write comments  yes",
      "",
    ].join("\n"))
  })
})
