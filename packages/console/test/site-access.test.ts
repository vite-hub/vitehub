import { fileURLToPath } from "node:url"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readConsolePublicKeys } from "@vite-hub/internal/console-signature"
import { createSiteState, siteStateHash, verifySiteToken } from "@vite-hub/internal/site-token"

import { readSiteIntent, siteIntentCookie, siteIntentLifetime, siteIntentSetCookie, siteMember } from "../src/site-access.ts"

import { operationRpcRequest, operationRpcResponse } from "../../internal/test-utils/operation-rpc.ts"

import type { OperationRpcTestResult } from "../../internal/test-utils/operation-rpc.ts"
import type { ConsoleDatabase, LinkedConsoleProject } from "../src/projects.ts"

const state = vi.hoisted(() => ({ db: undefined as unknown, user: null as { id: string } | null }))

vi.mock("vite-hub/database", () => ({ useDatabase: () => ({ db: state.db }) }))
vi.mock("vite-hub/auth/server", () => ({
  withAuthorization: () => async () => Response.json({ message: "Unauthorized." }, { status: 401 }),
  withAnonymousAuthorization: (_authorize: unknown, handler: (request: Request, authorization: { user: { id: string } | null }) => Promise<Response>) => (request: Request) => handler(request, { user: state.user }),
}))

const { createConsoleApiKey } = await import("../src/api-keys.ts")
const { createConsoleProjectStore } = await import("../src/projects.ts")
const { default: siteApi } = await import("../server/api/projects/[id]/site/[...path].ts")
const { default: siteOverview } = await import("../server/api/projects/[id]/site/index.ts")
const { default: commentsApi } = await import("../server/api/projects/[id]/comments-access/[...path].ts")
const { default: commentsOverview } = await import("../server/api/projects/[id]/comments-access/index.ts")
const { default: commentsInvite } = await import("../server/routes/comments/invite/[secret].ts")
const { default: visit } = await import("../server/routes/visit.ts")
const { default: invitePage } = await import("../server/routes/i/[id].ts")
const { default: codePage } = await import("../server/routes/go/[code].ts")

const consoleSecret = "c".repeat(64)
const consoleOrigin = "https://console.test"
const clients: ReturnType<typeof createClient>[] = []
const commentRoles = ["comments-read", "comments-write", "comments-resolve", "comments-delete"].map(id => ({ id, label: id }))
const app: { answer: OperationRpcTestResult, mcp: string[], name?: string, calls: { operation: string, user: string }[] } = { answer: { ok: true, value: { write: true, roles: commentRoles } }, mcp: [], calls: [] }

function callerOf(headers: Headers): string {
  const caller: unknown = JSON.parse(Buffer.from(headers.get("x-vitehub-caller") ?? "", "base64url").toString())
  return String(Reflect.get(Object(Reflect.get(Object(caller), "user")), "id"))
}

beforeEach(() => {
  vi.stubEnv("VITEHUB_CONSOLE_SECRET", consoleSecret)
  app.answer = { ok: true, value: { write: true, roles: commentRoles } }
  app.mcp = []
  delete app.name
  app.calls.length = 0
  vi.stubGlobal("fetch", vi.fn(async (target: Request | string | URL, init?: RequestInit) => {
    expect(String(target)).toBe("https://app.example.com/portal/_vitehub/rpc")
    const body: unknown = JSON.parse(init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : String(init?.body ?? "{}"))
    const { operation } = operationRpcRequest(body)
    const headers = new Headers(init?.headers)
    app.calls.push({ operation, user: callerOf(headers) })
    if (operation === "project.get") {
      const caller: unknown = JSON.parse(Buffer.from(headers.get("x-vitehub-caller") ?? "", "base64url").toString())
      expect(caller).toMatchObject({ surface: "mcp" })
      return operationRpcResponse(body, { ok: true, value: { ...(app.name ? { name: app.name } : {}), reference: app.mcp.map(name => ({ name })) } })
    }
    return operationRpcResponse(body, app.answer)
  }))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  state.user = null
  clients.splice(0).forEach(client => client.close())
})

async function setup() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.execute("PRAGMA foreign_keys = ON")
  const db = drizzle({ client })
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../server/databases/default/migrations/", import.meta.url)) })
  state.db = db
  const now = Date.now()
  for (const [id, name] of [["u-ada", "Ada"], ["u-bob", "Bob"]]) {
    await client.execute({ sql: "insert into user (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)", args: [id!, name!, `${name!.toLowerCase()}@example.com`, now, now] })
  }
  await client.execute({ sql: "insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)", args: ["t-ada", "Ada's team", "t-ada", now] })
  await client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)", args: ["m1", "t-ada", "u-ada", "owner", now] })
  const project = (await createConsoleProjectStore(db as ConsoleDatabase, consoleSecret, "t-ada").create({ url: "https://app.example.com/portal", createdBy: "u-ada" }))!
  const { key: apiKey } = (await createConsoleApiKey(db as ConsoleDatabase, { userId: "u-ada", teamId: "t-ada", name: "Test" }))!
  const api = async (method: string, path: string, body?: unknown, surface = "site", cookie = "") => {
    const request = new Request(`${consoleOrigin}/api/projects/${project.id}/${surface}${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const endpoints = surface === "site" ? { item: siteApi, list: siteOverview } : { item: commentsApi, list: commentsOverview }
    const response = await (path ? endpoints.item : endpoints.list).fetch(request)
    return { status: response.status, body: await response.json() as Record<string, unknown>, headers: response.headers }
  }
  const open = async (body: unknown, headers: Record<string, string> = {}) => await siteApi.fetch(new Request(`${consoleOrigin}/api/projects/${project.id}/site/open`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }))
  return { client, project, api, open }
}

function cookieOf(response: Response): string {
  return response.headers.getSetCookie()[0]!.split(";")[0]!
}

async function visitApp(cookie: string | undefined, project?: string) {
  const appState = createSiteState()
  const query = new URLSearchParams({ app: "https://app.example.com/portal", state: await siteStateHash(appState), return: "/docs", ...(project ? { project } : {}) })
  const response = await visit.fetch(new Request(`${consoleOrigin}/visit?${query}`, { headers: cookie ? { cookie } : {} }))
  return { response, appState, location: response.headers.get("location") ?? "" }
}

async function verifyAt(project: LinkedConsoleProject, location: string, appState: string) {
  const url = new URL(location)
  expect(`${url.origin}${url.pathname}`).toBe("https://app.example.com/portal/_vitehub/site")
  const keys = readConsolePublicKeys({ [project.keyVariable]: project.publicKey })
  if (!(keys instanceof Map)) throw new Error(keys.message)
  return await verifySiteToken({ token: url.searchParams.get("token")!, keys, origin: "https://app.example.com/portal", state: appState })
}

describe("Site access in the Console", () => {
  it("creates, opens, and revokes a hosted Comments invite without a call to the app", async () => {
    const { api, project } = await setup()
    const invite = { name: "Grace", grants: ["comments-write"], expiresInDays: 1 }
    expect((await api("POST", "/invites", { ...invite, grants: ["comments-delete"] }, "comments-access")).status).toBe(400)
    const created = await api("POST", "/invites", invite, "comments-access")
    expect(created.status).toBe(201)
    const link = new URL(String(created.body.url))
    expect(link.pathname).toMatch(/^\/comments\/invite\/[\w-]{43}$/)
    const opened = await commentsInvite.fetch(new Request(link))
    expect(opened.status).toBe(303)
    expect(opened.headers.get("location")).toBe(`${project.url}?comment=`)
    expect(cookieOf(opened)).toMatch(new RegExp(`^__Host-vitehub-comments-pass-${project.id}=[\\w-]{43}$`))
    expect((await commentsInvite.fetch(new Request(link))).status).toBe(410)
    const { body } = await api("GET", "", undefined, "comments-access")
    expect(body.sessions).toMatchObject([{ kind: "guest", person: { name: "Grace" }, grants: ["comments-write"] }])
    const session = (body.sessions as { id: string }[])[0]!
    expect((await api("DELETE", `/sessions/${session.id}`, undefined, "comments-access")).status).toBe(200)
    expect((await api("GET", "", undefined, "comments-access")).body.sessions).toEqual([])
    expect(app.calls).toEqual([])
  })

  it("lets only owners and admins invite and remove hosted Comments guests", async () => {
    const { client, project, api } = await setup()
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-write"], expiresInDays: 1 }, "comments-access")
    expect(created.status).toBe(201)
    await client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)", args: ["m2", "t-ada", "u-bob", "member", Date.now()] })
    const { key } = (await createConsoleApiKey(state.db as ConsoleDatabase, { userId: "u-bob", teamId: "t-ada", name: "Bob" }))!
    const asBob = async (method: string, path: string, body?: unknown) => {
      const request = new Request(`${consoleOrigin}/api/projects/${project.id}/comments-access${path}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return (path ? commentsApi : commentsOverview).fetch(request)
    }
    expect((await asBob("GET", "")).status).toBe(200)
    const invite = (created.body.invite as { id: string }).id
    for (const [method, path, body] of [["POST", "/invites", { name: "Eve", grants: ["comments-resolve", "comments-write"], expiresInDays: 30 }], ["DELETE", `/invites/${invite}`], ["DELETE", "/sessions/any"]] as const) {
      const response = await asBob(method, path, body)
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(await response.json()).toMatchObject({ code: "CONSOLE_SITE_FORBIDDEN" })
    }
    expect((await api("GET", "", undefined, "comments-access")).body.invites).toMatchObject([{ id: invite }])
    await client.execute({ sql: "update member set role = 'admin' where id = 'm2'", args: [] })
    expect((await asBob("DELETE", `/invites/${invite}`)).status).toBe(200)
  })

  it("opens a guest invite once, and signs tokens with the roles of the invite", async () => {
    const { client, project, api } = await setup()
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-write"], expiresInDays: 7, path: "/docs" })
    expect(created.status).toBe(201)
    const link = new URL(String(created.body.url))
    expect(link.pathname).toMatch(/^\/i\/[\w-]{43}$/)
    expect(JSON.stringify((await client.execute("select * from console_site_links")).rows)).not.toContain(link.pathname.slice(3))
    expect((await api("GET", "")).body.invites).toMatchObject([{ name: "Grace", grants: ["comments-write"], path: "/docs" }])

    const opened = await invitePage.fetch(new Request(link))
    expect(opened.status).toBe(303)
    const handoff = new URL(opened.headers.get("location")!)
    expect(`${handoff.origin}${handoff.pathname}`).toBe(`${project.url}/_vitehub/site`)
    expect(Object.fromEntries(handoff.searchParams)).toMatchObject({ return: "/docs", project: project.id, issuer: consoleOrigin, handoff: expect.any(String) })
    expect(opened.headers.getSetCookie()[0]).toMatch(new RegExp(`^__Host-vitehub-site-pass-${project.id}=[\\w-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$`))
    const again = await invitePage.fetch(new Request(link))
    expect(again.status).toBe(410)
    expect((await api("GET", "")).body.invites).toEqual([])

    const { location, appState } = await visitApp(cookieOf(opened))
    const verified = await verifyAt(project, location, appState)
    expect(verified).toMatchObject({ ok: true, destination: "https://app.example.com/portal/docs", claims: { name: "Grace", roles: ["comments-write"], kind: "site", path: "/docs" } })
    expect(verified.ok && verified.claims.sub).toMatch(/^site-guest:/)
    expect(verified.ok && verified.claims.email).toBeUndefined()
  })

  it("stops new tokens after a revoke", async () => {
    const { api } = await setup()
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-read"] })
    const cookie = cookieOf(await invitePage.fetch(new Request(String(created.body.url))))
    const sessions = (await api("GET", "")).body.sessions as { id: string, kind: string }[]
    expect(sessions).toMatchObject([{ kind: "guest", person: { name: "Grace" }, grants: ["comments-read"] }])
    expect(await api("DELETE", `/sessions/${sessions[0]!.id}`)).toMatchObject({ status: 200, body: { revoked: true, removedUser: true } })
    expect((await api("GET", "")).body.sessions).toEqual([])
    const { location } = await visitApp(cookie)
    expect(location).toMatch(/^\/open\?/)
    expect(Object.fromEntries(new URL(location, consoleOrigin).searchParams)).toMatchObject({ project: "https://app.example.com/portal", site: "/docs" })
    expect(await api("DELETE", `/sessions/${sessions[0]!.id}`)).toMatchObject({ status: 404 })
  })

  it("gives the app no email for a passkey account", async () => {
    const { client, project } = await setup()
    const now = Date.now()
    await client.execute({ sql: "insert into user (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)", args: ["u-cy", "Cy", "u-cy@passkey.invalid", now, now] })
    await client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)", args: ["m2", "t-ada", "u-cy", "member", now] })
    const db = state.db as ConsoleDatabase
    expect(await siteMember(db, project, "u-cy")).toEqual({ id: "u-cy", name: "Cy" })
    expect(await siteMember(db, project, "u-ada")).toEqual({ id: "u-ada", name: "Ada", email: "ada@example.com" })
  })

  it("works a one-time code once, for a member while they are in the team", async () => {
    const { client, project, api } = await setup()
    const code = await api("POST", "/codes", { path: "/runs/42" })
    expect(code.status).toBe(201)
    const link = String(code.body.url)
    expect(new URL(link).pathname).toMatch(/^\/go\/[\w-]{43}$/)
    expect(Date.parse(String(code.body.expiresAt)) - Date.now()).toBeGreaterThan(9 * 60_000)
    const opened = await codePage.fetch(new Request(link, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" } }))
    expect(opened.status).toBe(303)
    expect(Object.fromEntries(new URL(opened.headers.get("location")!).searchParams)).toMatchObject({ return: "/runs/42", project: project.id, issuer: consoleOrigin, handoff: expect.any(String) })
    expect((await codePage.fetch(new Request(link))).status).toBe(410)
    const cookie = cookieOf(opened)
    const { location, appState } = await visitApp(cookie)
    expect(await verifyAt(project, location, appState)).toMatchObject({ ok: true, claims: { sub: "u-ada", name: "Ada", email: "ada@example.com", roles: ["console", "comments-read", "comments-write", "comments-resolve", "comments-delete"] } })
    expect((await api("GET", "")).body.sessions).toMatchObject([{ kind: "member", person: { id: "u-ada", name: "Ada" } }])

    await client.execute("delete from member where id = 'm1'")
    expect((await visitApp(cookie)).location).toMatch(/^\/open\?/)
  })

  it("refuses invites that Site access cannot give, and a revoked invite opens no more", async () => {
    const { api } = await setup()
    expect(await api("POST", "/invites", { name: "Grace", grants: ["console"] })).toMatchObject({ status: 400, body: { message: expect.stringContaining("never get the Console") } })
    expect(await api("POST", "/invites", { name: "Grace", grants: ["admin"] })).toMatchObject({ status: 400, body: { message: expect.stringContaining("no role admin") } })
    expect(await api("POST", "/invites", { name: "Grace", grants: [] })).toMatchObject({ status: 400 })
    expect(await api("POST", "/invites", { name: " ", grants: ["comments-read"] })).toMatchObject({ status: 400 })
    expect(await api("POST", "/invites", { name: "x".repeat(65), grants: ["comments-read"] })).toMatchObject({ status: 400 })
    expect(await api("POST", "/invites", { name: "Grace", grants: ["comments-read"], expiresInDays: 3 })).toMatchObject({ status: 400 })
    expect(await api("POST", "/invites", { name: "Grace", grants: ["comments-read"], path: "//evil.example" })).toMatchObject({ status: 400 })
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-read"], expiresInDays: 1 })
    const id = (created.body.invite as { id: string }).id
    expect(await api("DELETE", `/invites/${id}`)).toMatchObject({ status: 200, body: { revoked: true } })
    expect(await api("DELETE", `/invites/${id}`)).toMatchObject({ status: 404 })
    expect((await invitePage.fetch(new Request(String(created.body.url)))).status).toBe(410)
    expect((await invitePage.fetch(new Request(`${consoleOrigin}/i/unknown`))).status).toBe(404)
  })

  it("records revocable member browsers from a visit and from the Console page", async () => {
    const { project, api } = await setup()
    expect((await visitApp(undefined)).location).toMatch(/^\/open\?/)
    state.user = { id: "u-bob" }
    expect((await visitApp(undefined)).location).toMatch(/^\/open\?/)
    state.user = { id: "u-ada" }
    const visited = await visitApp(undefined)
    expect(await verifyAt(project, visited.location, visited.appState)).toMatchObject({ ok: true, claims: { sub: "u-ada", roles: expect.arrayContaining(["console"]) } })
    const visitPass = cookieOf(visited.response)
    expect((await api("GET", "")).body.sessions).toMatchObject([{ kind: "member", person: { id: "u-ada" }, grants: expect.arrayContaining(["console"]) }])

    const appState = createSiteState()
    const input = { path: "/runs/42", state: await siteStateHash(appState) }
    const token = await api("POST", "/token", input)
    expect(await verifyAt(project, String(token.body.url), appState)).toMatchObject({ ok: true, claims: { path: "/runs/42", aud: "https://app.example.com/portal" } })
    const tokenPass = token.headers.getSetCookie()[0]!.split(";")[0]!
    expect(tokenPass).not.toBe(visitPass)
    expect((await api("POST", "/token", input, "site", tokenPass)).headers.getSetCookie()[0]).toContain(`${tokenPass};`)
    expect(await api("POST", "/token", { path: "/", state: "short" })).toMatchObject({ status: 400 })

    state.user = null
    const sessions = (await api("GET", "")).body.sessions as { id: string }[]
    expect(sessions).toHaveLength(2)
    for (const pass of [visitPass, tokenPass]) expect((await visitApp(pass)).response.status).toBe(303)
    for (const { id } of sessions) expect((await api("DELETE", `/sessions/${id}`)).status).toBe(200)
    for (const pass of [visitPass, tokenPass]) expect((await visitApp(pass)).location).toMatch(/^\/open\?/)
  })

  it("asks the app for its Site access policy before each action, and gives only the roles of that policy", async () => {
    const { project, api } = await setup()
    app.answer = { ok: true, value: { write: false, roles: commentRoles.slice(0, 1) } }
    const overview = await api("GET", "")
    expect(overview.status).toBe(200)
    expect(overview.body).not.toHaveProperty("members")
    expect((overview.body.grants as { id: string }[]).map(role => role.id)).toEqual(["console", "comments-read"])
    for (const [path, body] of [["/invites", { name: "Grace", grants: ["comments-read"] }], ["/codes", {}], ["/token", { path: "/", state: "a".repeat(43) }]] as const) {
      expect(await api("POST", path, body), path).toMatchObject({ status: 403, body: { code: "CONSOLE_SITE_FORBIDDEN" } })
    }

    app.answer = { ok: true, value: { write: true, roles: commentRoles.slice(0, 1) } }
    expect(await api("POST", "/invites", { name: "Grace", grants: ["comments-write"] })).toMatchObject({ status: 400, body: { message: expect.stringContaining("no role comments-write") } })
    const appState = createSiteState()
    const token = await api("POST", "/token", { path: "/docs", state: await siteStateHash(appState) })
    expect(await verifyAt(project, String(token.body.url), appState)).toMatchObject({ ok: true, claims: { roles: ["console", "comments-read"] } })

    app.answer = { ok: false, code: "CONSOLE_ACCESS_DENIED", message: "Only admins manage Site access.", status: 403 }
    expect(await api("GET", "")).toMatchObject({ status: 403, body: { code: "CONSOLE_ACCESS_DENIED" } })
    state.user = { id: "u-ada" }
    expect((await visitApp(undefined)).location).toMatch(/^\/open\?/)
    expect(app.calls.every(call => call.user === "u-ada")).toBe(true)
  })

  it.each([
    [[], undefined],
    [["comments.get"], false],
    [["comments.get", "comments.resolve"], true],
  ] as const)("signs the Comments handoff from MCP operations %j", async (operations, resolve) => {
    const { project, api } = await setup()
    app.mcp = [...operations]
    const state = createSiteState()
    const token = await api("POST", "/token", { path: "/docs", state: await siteStateHash(state) })
    const match = await verifyAt(project, String(token.body.url), state)
    expect(match.ok).toBe(true)
    if (!match.ok) throw new Error("Expected a valid Site access token")
    expect(match.claims.commentsAgent).toEqual(resolve === undefined ? undefined : { projectId: project.id, teamId: project.teamId, resolve })
  })

  it("names the app in the Comments handoff by the label of the link, else by the name the app reports", async () => {
    const { project, api } = await setup()
    app.mcp = ["comments.get"]
    app.name = "acme-docs"
    const signed = async () => {
      const state = createSiteState()
      const token = await api("POST", "/token", { path: "/docs", state: await siteStateHash(state) })
      const match = await verifyAt(project, String(token.body.url), state)
      if (!match.ok) throw new Error("Expected a valid Site access token")
      return match.claims.commentsAgent
    }
    expect(await signed()).toEqual({ projectId: project.id, teamId: project.teamId, resolve: false, name: "acme-docs" })
    await createConsoleProjectStore(state.db as ConsoleDatabase, consoleSecret, "t-ada").rename(project.id, "Acme Docs")
    expect(await signed()).toEqual({ projectId: project.id, teamId: project.teamId, resolve: false, name: "Acme Docs" })
  })

  it("keeps a pass to the project that issued it when two teams link the same app", async () => {
    const { client, project, api } = await setup()
    await client.execute({ sql: "insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)", args: ["t-bob", "Bob's team", "t-bob", Date.now()] })
    const other = (await createConsoleProjectStore(state.db as ConsoleDatabase, consoleSecret, "t-bob").create({ url: "https://app.example.com/portal", createdBy: "u-bob" }))!
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-read"] })
    const opened = await invitePage.fetch(new Request(String(created.body.url)))
    expect(new URL(opened.headers.get("location")!).searchParams.get("project")).toBe(project.id)
    const cookie = cookieOf(opened)
    const fallback = (await visitApp(cookie, other.id)).location
    expect(new URL(fallback, consoleOrigin).searchParams.get("app")).toBe(other.id)
    const { location, appState } = await visitApp(cookie, project.id)
    expect(await verifyAt(project, location, appState)).toMatchObject({ ok: true, claims: { name: "Grace" } })
    expect(await verifyAt(other, location, appState)).toMatchObject({ ok: false, code: "SITE_TOKEN_KEY_UNKNOWN" })
  })

  it("refuses the code of a removed member in one step, without a pass and without using the code", async () => {
    const { client, api } = await setup()
    const code = await api("POST", "/codes", { path: "/runs/42" })
    await client.execute("delete from member where id = 'm1'")
    const opened = await codePage.fetch(new Request(String(code.body.url)))
    expect(opened.status).toBe(403)
    expect(opened.headers.getSetCookie()).toEqual([])
    expect((await client.execute("select count(*) as count from console_site_grants")).rows[0]!.count).toBe(0)
    await client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)", args: ["m2", "t-ada", "u-ada", "owner", Date.now()] })
    expect((await codePage.fetch(new Request(String(code.body.url)))).status).toBe(303)
  })

  it("checks the app policy of a code's member before it uses the code", async () => {
    const { api } = await setup()
    const code = await api("POST", "/codes", {})
    app.answer = { ok: false, code: "CONSOLE_ACCESS_DENIED", message: "No Site access.", status: 403 }
    const refused = await codePage.fetch(new Request(String(code.body.url)))
    expect(refused.status).toBe(403)
    expect(refused.headers.getSetCookie()).toEqual([])
    app.answer = { ok: true, value: { write: true, roles: commentRoles } }
    expect((await codePage.fetch(new Request(String(code.body.url)))).status).toBe(303)
  })

  it("checks the app policy of the inviter before it uses an invite", async () => {
    const { api } = await setup()
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-write"] })
    app.answer = { ok: true, value: { write: true, roles: commentRoles.slice(0, 1) } }
    const refused = await invitePage.fetch(new Request(String(created.body.url)))
    expect(refused.status).toBe(403)
    expect(refused.headers.getSetCookie()).toEqual([])
    expect((await api("GET", "")).body.invites).toMatchObject([{ name: "Grace" }])
    app.answer = { ok: true, value: { write: true, roles: commentRoles } }
    expect((await invitePage.fetch(new Request(String(created.body.url)))).status).toBe(303)
  })

  it("applies the current app policy of the inviter before each guest token", async () => {
    const { api } = await setup()
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-write"] })
    const cookie = cookieOf(await invitePage.fetch(new Request(String(created.body.url))))
    app.calls.length = 0
    expect((await visitApp(cookie)).location).toMatch(/^https:\/\/app\.example\.com\//)
    expect(app.calls).toEqual([{ operation: "site.access", user: "u-ada" }])
    app.answer = { ok: true, value: { write: true, roles: commentRoles.slice(0, 1) } }
    expect((await visitApp(cookie)).location).toMatch(/^\/open\?/)
    app.answer = { ok: true, value: { write: false, roles: commentRoles } }
    expect((await visitApp(cookie)).location).toMatch(/^\/open\?/)
  })

  it("refuses a guest invite with a membersOnly role", async () => {
    const { api } = await setup()
    app.answer = { ok: true, value: { write: true, roles: [...commentRoles, { id: "site-admin", label: "Site admin", membersOnly: true }] } }
    expect(await api("POST", "/invites", { name: "Grace", grants: ["site-admin"] })).toMatchObject({ status: 400, body: { message: expect.stringContaining("Only members get site-admin") } })
  })

  it("leaves an invite open when its pass cannot be written", async () => {
    const { client, api } = await setup()
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-read"] })
    await client.execute("create trigger fail_pass before insert on console_site_grants begin select raise(abort, 'no pass'); end")
    await expect(invitePage.fetch(new Request(String(created.body.url)))).rejects.toThrow()
    expect((await api("GET", "")).body.invites).toMatchObject([{ name: "Grace" }])
    await client.execute("drop trigger fail_pass")
    expect((await invitePage.fetch(new Request(String(created.body.url)))).status).toBe(303)
  })

  it("shows the roles of the last token of each member browser", async () => {
    const { api } = await setup()
    const code = await api("POST", "/codes", {})
    const cookie = cookieOf(await codePage.fetch(new Request(String(code.body.url))))
    await visitApp(cookie)
    app.answer = { ok: true, value: { write: true, roles: commentRoles.slice(0, 1) } }
    expect((await api("GET", "")).body.sessions).toMatchObject([{ kind: "member", grants: ["console", ...commentRoles.map(role => role.id)] }])
  })

  it("refuses a malformed visit", async () => {
    await setup()
    for (const query of ["app=https%3A%2F%2Fapp.example.com&state=short", `app=https%3A%2F%2Fapp.example.com&state=${"a".repeat(43)}&return=%2F%2Fevil.example`, `state=${"a".repeat(43)}`]) {
      expect((await visit.fetch(new Request(`${consoleOrigin}/visit?${query}`))).status, query).toBe(400)
    }
  })
})

describe("Impersonation and Content preview in the Console", () => {
  const start = { kind: "impersonate", target: { action: "start", userId: "app-user-1" } }

  async function intentVisit(url: string, cookie: string, app = "https://app.example.com/portal") {
    const link = new URL(url)
    const appState = createSiteState()
    const query = new URLSearchParams({ app, state: await siteStateHash(appState), return: link.searchParams.get("return")!, project: link.searchParams.get("project")!, intent: link.searchParams.get("intent")! })
    const response = await visit.fetch(new Request(`${consoleOrigin}/visit?${query}`, { headers: cookie ? { cookie } : {} }))
    return { response, appState, location: response.headers.get("location") ?? "" }
  }

  it("checks the action with the app as the member, keeps it in this browser for 60 seconds, and signs a token of its kind at /visit", async () => {
    const { project, open } = await setup()
    app.answer = { ok: true, value: { path: "/" } }
    const opened = await open(start)
    expect(opened.status).toBe(201)
    const body = await opened.json() as { url: string, expiresAt: string }
    const url = new URL(body.url)
    expect(`${url.origin}${url.pathname}`).toBe("https://app.example.com/portal/_vitehub/site")
    expect(Object.fromEntries(url.searchParams)).toEqual({ return: "/", project: project.id, intent: expect.stringMatching(/^[\w-]{43}$/) })
    expect(Date.parse(body.expiresAt) - Date.now()).toBeLessThanOrEqual(siteIntentLifetime)
    const [cookieLine] = opened.headers.getSetCookie()
    expect(cookieLine).toMatch(new RegExp(`^__Host-vitehub-site-intent-${url.searchParams.get("intent")}=[\\w-]+; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure$`))
    expect(app.calls).toEqual([{ operation: "auth.impersonate", user: "u-ada" }])

    state.user = { id: "u-ada" }
    const visited = await intentVisit(body.url, cookieOf(opened))
    expect(visited.response.status).toBe(303)
    const keys = readConsolePublicKeys({ [project.keyVariable]: project.publicKey })
    if (!(keys instanceof Map)) throw new Error(keys.message)
    const location = new URL(visited.location)
    expect(location.searchParams.get("intent")).toBe(url.searchParams.get("intent"))
    const verified = await verifySiteToken({ token: location.searchParams.get("token")!, keys, origin: "https://app.example.com/portal", state: visited.appState, kinds: ["impersonate"] })
    expect(verified).toMatchObject({ ok: true, claims: { kind: "impersonate", target: start.target, roles: [], path: "/", sub: "u-ada" } })
    expect(await verifySiteToken({ token: location.searchParams.get("token")!, keys, origin: "https://app.example.com/portal", state: visited.appState })).toMatchObject({ ok: false, code: "SITE_TOKEN_KIND" })
    expect(visited.response.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-vitehub-site-intent-[\w-]{43}=; .*Max-Age=0/)])
    expect(app.calls).toEqual([{ operation: "auth.impersonate", user: "u-ada" }, { operation: "auth.impersonate", user: "u-ada" }])

    expect((await intentVisit(body.url, "")).response.status).toBe(410)
  })

  it("opens an action only from a JSON request of the Console origin, and /visit uses the intent only with GET", async () => {
    const { open } = await setup()
    app.answer = { ok: true, value: { path: "/" } }
    expect((await open(start, { "content-type": "text/plain" })).status).toBe(415)
    expect((await open(start, { "sec-fetch-site": "same-site" })).status).toBe(403)
    expect(app.calls).toEqual([])
    const opened = await open(start, { "sec-fetch-site": "same-origin" })
    expect(opened.status).toBe(201)
    state.user = { id: "u-ada" }
    const link = new URL((await opened.json() as { url: string }).url)
    const query = new URLSearchParams({ app: "https://app.example.com/portal", state: await siteStateHash(createSiteState()), return: "/", project: link.searchParams.get("project")!, intent: link.searchParams.get("intent")! })
    expect((await visit.fetch(new Request(`${consoleOrigin}/visit?${query}`, { method: "HEAD", headers: { cookie: cookieOf(opened) } }))).status).toBe(405)
  })

  it("answers the path of a document preview from the app", async () => {
    const { open } = await setup()
    app.answer = { ok: true, value: { path: "/blog/hello?draft=1" } }
    const opened = await open({ kind: "preview", target: { collection: "posts", id: "hello", section: "content" } })
    expect(opened.status).toBe(201)
    expect(new URL((await opened.json() as { url: string }).url).searchParams.get("return")).toBe("/blog/hello?draft=1")
    expect(app.calls).toEqual([{ operation: "documents.preview", user: "u-ada" }])
  })

  it("refuses an action that is malformed, or that the app refuses, and keeps nothing in the browser", async () => {
    const { open } = await setup()
    for (const body of [{ kind: "site", target: {} }, { kind: "impersonate", target: { action: "start" } }, { kind: "preview", target: { collection: "posts" } }, { kind: "impersonate", target: "x" }]) {
      const response = await open(body)
      expect(response.status, JSON.stringify(body)).toBe(400)
      expect(await response.json()).toMatchObject({ code: "CONSOLE_SITE_ACTION_INVALID" })
      expect(response.headers.getSetCookie()).toEqual([])
    }
    app.answer = { ok: false, code: "CONSOLE_ACCESS_DENIED", message: "Impersonation is off.", status: 404 }
    const refused = await open(start)
    expect(refused.status).toBe(404)
    expect(await refused.json()).toMatchObject({ code: "CONSOLE_ACCESS_DENIED", message: "The app refused it: Impersonation is off." })
    expect(refused.headers.getSetCookie()).toEqual([])
    app.answer = { ok: true, value: { path: "https://evil.example/" } }
    expect((await open(start)).status).toBe(502)
  })

  it("signs no token for another Console account, another app, or after the app refuses the action at /visit", async () => {
    const { open } = await setup()
    app.answer = { ok: true, value: { path: "/" } }
    const opened = await open(start)
    const { url } = await opened.json() as { url: string }
    const cookie = cookieOf(opened)

    state.user = { id: "u-bob" }
    const bob = await intentVisit(url, cookie)
    expect(bob.response.status).toBe(403)
    expect(bob.response.headers.getSetCookie()).toEqual([expect.stringMatching(/Max-Age=0/)])

    state.user = { id: "u-ada" }
    const elsewhere = await intentVisit(url, cookie, "https://other.example.com")
    expect(elsewhere.response.status).toBe(400)
    expect(elsewhere.location).toBe("")

    app.answer = { ok: false, code: "CONSOLE_ACCESS_DENIED", message: "Only admins impersonate.", status: 403 }
    const refused = await intentVisit(url, cookie)
    expect(refused.response.status).toBe(403)
    expect(await refused.response.text()).toContain("Only admins impersonate. (CONSOLE_ACCESS_DENIED)")
    expect(refused.location).toBe("")
  })

  it("reads an intent cookie only while it is valid and before it expires", () => {
    const intent = { user: "u-ada", project: "p1", kind: "preview" as const, target: { collection: "posts", id: "hello", section: "content" }, expiresAt: 2_000 }
    const value = siteIntentSetCookie("i".repeat(43), intent, false).split(";")[0]!.split("=")[1]!
    expect(siteIntentCookie("i".repeat(43), false)).toBe(`vitehub-site-intent-${"i".repeat(43)}`)
    expect(readSiteIntent(value, 1_000)).toEqual(intent)
    expect(readSiteIntent(value, 2_000)).toBeUndefined()
    expect(readSiteIntent(undefined)).toBeUndefined()
    expect(readSiteIntent("not-json", 1_000)).toBeUndefined()
    const site = siteIntentSetCookie("i".repeat(43), { ...intent, kind: "site" as never }, false).split(";")[0]!.split("=")[1]!
    expect(readSiteIntent(site, 1_000)).toBeUndefined()
    expect(siteIntentSetCookie("i".repeat(43), undefined, true)).toBe(`__Host-vitehub-site-intent-${"i".repeat(43)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`)
  })
})
