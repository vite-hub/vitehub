import { fileURLToPath } from "node:url"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readConsolePublicKeys } from "@vite-hub/internal/console-signature"
import { createSiteState, siteStateHash, verifySiteToken } from "@vite-hub/internal/site-token"

import type { ConsoleDatabase, ConsoleProject } from "../src/projects.ts"

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
const { default: visit } = await import("../server/routes/visit.ts")
const { default: invitePage } = await import("../server/routes/i/[id].ts")
const { default: codePage } = await import("../server/routes/go/[code].ts")

const consoleSecret = "c".repeat(64)
const consoleOrigin = "https://console.test"
const clients: ReturnType<typeof createClient>[] = []

beforeEach(() => { vi.stubEnv("VITEHUB_CONSOLE_SECRET", consoleSecret) })
afterEach(() => {
  vi.unstubAllEnvs()
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
  const api = async (method: string, path: string, body?: unknown) => {
    const request = new Request(`${consoleOrigin}/api/projects/${project.id}/site${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const response = await (path ? siteApi : siteOverview).fetch(request)
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  return { client, project, api }
}

function cookieOf(response: Response): string {
  return response.headers.getSetCookie()[0]!.split(";")[0]!
}

async function visitApp(cookie: string | undefined) {
  const appState = createSiteState()
  const query = new URLSearchParams({ app: "https://app.example.com/portal", state: await siteStateHash(appState), return: "/docs" })
  const response = await visit.fetch(new Request(`${consoleOrigin}/visit?${query}`, { headers: cookie ? { cookie } : {} }))
  return { response, appState, location: response.headers.get("location") ?? "" }
}

async function verifyAt(project: ConsoleProject, location: string, appState: string) {
  const url = new URL(location)
  expect(`${url.origin}${url.pathname}`).toBe("https://app.example.com/portal/_vitehub/site")
  const keys = readConsolePublicKeys({ [project.keyVariable]: project.publicKey })
  if (!(keys instanceof Map)) throw new Error(keys.message)
  return await verifySiteToken({ token: url.searchParams.get("token")!, keys, origin: "https://app.example.com", state: appState })
}

describe("Site access in the Console", () => {
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
    expect(opened.headers.get("location")).toBe("https://app.example.com/portal/_vitehub/site?return=%2Fdocs")
    expect(opened.headers.getSetCookie()[0]).toMatch(new RegExp(`^__Host-vitehub-site-pass-${project.id}=[\\w-]{43}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$`))
    const again = await invitePage.fetch(new Request(link))
    expect(again.status).toBe(410)
    expect((await api("GET", "")).body.invites).toEqual([])

    const { location, appState } = await visitApp(cookieOf(opened))
    const verified = await verifyAt(project, location, appState)
    expect(verified).toMatchObject({ ok: true, claims: { name: "Grace", roles: ["comments-write"], kind: "site", path: "/docs" } })
    expect(verified.ok && verified.claims.sub).toMatch(/^site-guest:/)
    expect(verified.ok && verified.claims.email).toBeUndefined()
  })

  it("stops new tokens after a revoke", async () => {
    const { api } = await setup()
    const created = await api("POST", "/invites", { name: "Grace", grants: ["comments-read"] })
    const cookie = cookieOf(await invitePage.fetch(new Request(String(created.body.url))))
    const sessions = (await api("GET", "")).body.sessions as { id: string, kind: string }[]
    expect(sessions).toMatchObject([{ kind: "guest", person: { name: "Grace" }, grants: ["comments-read"] }])
    expect(await api("DELETE", `/sessions/${sessions[0]!.id}`)).toEqual({ status: 200, body: { revoked: true, removedUser: true } })
    expect((await api("GET", "")).body.sessions).toEqual([])
    const { location } = await visitApp(cookie)
    expect(location).toMatch(/^\/open\?/)
    expect(Object.fromEntries(new URL(location, consoleOrigin).searchParams)).toMatchObject({ project: "https://app.example.com/portal", site: "/docs" })
    expect(await api("DELETE", `/sessions/${sessions[0]!.id}`)).toMatchObject({ status: 404 })
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
    expect(await api("DELETE", `/invites/${id}`)).toEqual({ status: 200, body: { revoked: true } })
    expect(await api("DELETE", `/invites/${id}`)).toMatchObject({ status: 404 })
    expect((await invitePage.fetch(new Request(String(created.body.url)))).status).toBe(410)
    expect((await invitePage.fetch(new Request(`${consoleOrigin}/i/unknown`))).status).toBe(404)
  })

  it("signs a token for a signed-in member, from a visit or from the Console page", async () => {
    const { project, api } = await setup()
    expect((await visitApp(undefined)).location).toMatch(/^\/open\?/)
    state.user = { id: "u-bob" }
    expect((await visitApp(undefined)).location).toMatch(/^\/open\?/)
    state.user = { id: "u-ada" }
    const visited = await visitApp(undefined)
    expect(await verifyAt(project, visited.location, visited.appState)).toMatchObject({ ok: true, claims: { sub: "u-ada", roles: expect.arrayContaining(["console"]) } })

    const appState = createSiteState()
    const token = await api("POST", "/token", { path: "/runs/42", state: await siteStateHash(appState) })
    expect(await verifyAt(project, String(token.body.url), appState)).toMatchObject({ ok: true, claims: { path: "/runs/42", aud: "https://app.example.com" } })
    expect(await api("POST", "/token", { path: "/", state: "short" })).toMatchObject({ status: 400 })
  })

  it("refuses a malformed visit", async () => {
    await setup()
    for (const query of ["app=https%3A%2F%2Fapp.example.com&state=short", `app=https%3A%2F%2Fapp.example.com&state=${"a".repeat(43)}&return=%2F%2Fevil.example`, `state=${"a".repeat(43)}`]) {
      expect((await visit.fetch(new Request(`${consoleOrigin}/visit?${query}`))).status, query).toBe(400)
    }
  })
})
