import { fileURLToPath } from "node:url"

import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, describe, expect, it, vi } from "vitest"

import { encodeConsoleBase64url } from "@vite-hub/internal/console-signature"
import { createRestTransport } from "vite-hub/comments/client"
import { hostedCommentNoticeRoom } from "vite-hub/comments/server"

import { authorizeHostedComments, handleHostedCommentsApi, hostedCommentsRealtime, redeemHostedComments } from "../src/hosted-comments.ts"
import { createConsoleProjectStore } from "../src/projects.ts"
import { createConsoleSiteStore, sitePassCookie } from "../src/site-access.ts"

import type { RealtimeRequestEvent } from "vite-hub/realtime"
import type { ConsoleDatabase, ConsoleProject } from "../src/projects.ts"

const notices = vi.hoisted(() => [] as { definition: string, room: string, body: unknown, user: string | undefined }[])

vi.mock("vite-hub/realtime/server", async original => ({
  ...await original<typeof import("vite-hub/realtime/server")>(),
  notifyRealtimeRoom: async (definition: string, room: string, body: unknown, options?: { user?: string }) => {
    notices.push({ definition, room, body, user: options?.user })
  },
}))

const memberReads = vi.hoisted(() => ({ before: undefined as ((userId: string) => void) | undefined }))

vi.mock("../src/site-access.ts", async (original) => {
  const access = await original<typeof import("../src/site-access.ts")>()
  return {
    ...access,
    siteMember: async (...input: Parameters<typeof access.siteMember>) => {
      memberReads.before?.(input[2])
      return await access.siteMember(...input)
    },
  }
})

const secret = "c".repeat(64)
const consoleOrigin = "https://console.test"
const allRoles = ["comments-read", "comments-write", "comments-resolve", "comments-delete"]
const clients: ReturnType<typeof createClient>[] = []
const anchor = { kind: "page" as const }

afterEach(() => {
  clients.splice(0).forEach(client => client.close())
  notices.length = 0
  memberReads.before = undefined
  vi.useRealTimers()
})

async function sha256(value: string): Promise<string> {
  return encodeConsoleBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))))
}

async function pkce() {
  const verifier = encodeConsoleBase64url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: await sha256(verifier) }
}

async function setup() {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  await client.execute("PRAGMA foreign_keys = ON")
  // SAFETY: the libSQL Drizzle database is the async SQLite Database that the Console uses.
  const db = drizzle({ client }) as unknown as ConsoleDatabase
  await migrate(drizzle({ client }), { migrationsFolder: fileURLToPath(new URL("../server/databases/default/migrations/", import.meta.url)) })
  const now = Date.now()
  for (const [id, name] of [["u-ada", "Ada"], ["u-bob", "Bob"], ["u-eve", "Eve"]] as const) {
    await client.execute({ sql: "insert into user (id, name, email, email_verified, created_at, updated_at) values (?, ?, ?, 0, ?, ?)", args: [id, name, `${name.toLowerCase()}@example.com`, now, now] })
  }
  for (const [team, user] of [["t-ada", "u-ada"], ["t-eve", "u-eve"]] as const) {
    await client.execute({ sql: "insert into organization (id, name, slug, created_at) values (?, ?, ?, ?)", args: [team, team, team, now] })
    await client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values (?, ?, ?, ?, ?)", args: [`m-${user}`, team, user, "owner", now] })
  }
  const link = async (team: string, user: string, url: string) => (await createConsoleProjectStore(db, secret, team).create({ url, createdBy: user }))!
  const portal = await link("t-ada", "u-ada", "https://app.example.com/portal")
  const other = await link("t-eve", "u-eve", "https://other.example.com")
  const grant = async (id: string, roles: string[], extra: { revokedAt?: number, expiresAt?: number, createdBy?: string } = {}) => {
    const pass = `pass-${id}-${"p".repeat(32)}`
    await client.execute({
      sql: "insert into console_site_grants (id, project_id, kind, user_id, name, roles, secret_hash, device, created_by, created_at, last_seen_at, expires_at, revoked_at) values (?, ?, 'comments', null, 'Grace', ?, ?, 'Firefox', ?, ?, ?, ?, ?)",
      args: [id, portal.id, JSON.stringify(roles), await sha256(pass), extra.createdBy ?? "u-ada", now, now, extra.expiresAt ?? now + 86_400_000, extra.revokedAt ?? null],
    })
    return `${sitePassCookie(portal.id, true, "comments")}=${pass}`
  }
  const join = (user: string) => client.execute({ sql: "insert into member (id, organization_id, user_id, role, created_at) values (?, 't-ada', ?, 'member', ?)", args: [`m-${user}`, user, now] })
  const leave = (user: string) => client.execute({ sql: "delete from member where user_id = ?", args: [user] })
  const count = async (table: string) => Number((await client.execute(`select count(*) as n from ${table}`)).rows[0]!.n)
  return { client, db, portal, other, grant, join, leave, count }
}

interface Authorize { userId?: string, cookie?: string, challenge?: string, return?: string, headers?: Record<string, string>, now?: number, linked?: boolean }

function authorize(db: ConsoleDatabase, project: ConsoleProject, input: Authorize = {}) {
  const query = new URLSearchParams({ challenge: input.challenge ?? "x".repeat(43), ...(input.return === undefined ? {} : { return: input.return }) })
  if (input.linked) query.set("linked", "")
  const headers = new Headers(input.headers)
  if (input.cookie) headers.set("cookie", input.cookie)
  return authorizeHostedComments(new Request(`${consoleOrigin}/comments/${project.id}/authorize?${query}`, { headers }), { db, userId: input.userId ?? null, ...(input.now === undefined ? {} : { now: input.now }) })
}

function codeOf(response: Response): string {
  return new URL(response.headers.get("location")!).hash.replace(/^#vhc=/, "")
}

function redeem(db: ConsoleDatabase, projectId: string, body: unknown, init: { headers?: Record<string, string>, now?: number } = {}) {
  const request = new Request(`${consoleOrigin}/comments/${projectId}/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "origin": consoleOrigin, ...init.headers },
    body: JSON.stringify(body),
  })
  return redeemHostedComments(request, { db, ...(init.now === undefined ? {} : { now: init.now }) })
}

async function signIn(db: ConsoleDatabase, project: ConsoleProject, input: Authorize = {}): Promise<string> {
  const { verifier, challenge } = await pkce()
  const authorized = await authorize(db, project, { ...input, challenge })
  expect(authorized.status).toBe(303)
  const redeemed = await redeem(db, project.id, { code: codeOf(authorized), verifier }, input.now === undefined ? {} : { now: input.now })
  expect(redeemed.status).toBe(200)
  const { token } = await redeemed.json() as { token: string }
  return token
}

function call(db: ConsoleDatabase, projectId: string, token: string | undefined, path: string, init: { method?: string, json?: unknown, headers?: Record<string, string>, now?: number } = {}) {
  const headers = new Headers(init.headers)
  if (token) headers.set("authorization", `Bearer ${token}`)
  if (init.json !== undefined) headers.set("content-type", "application/json")
  const request = new Request(`${consoleOrigin}/comments/${projectId}/api${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  })
  return handleHostedCommentsApi(request, { db, ...(init.now === undefined ? {} : { now: init.now }) })
    .then(async response => ({ status: response.status, headers: response.headers, body: await response.json() as { data?: unknown, error?: { code: string } } }))
}

function embed(db: ConsoleDatabase, project: ConsoleProject, token: string) {
  return createRestTransport({
    base: `${consoleOrigin}/comments/${project.id}`,
    credentials: "omit",
    headers: { authorization: `Bearer ${token}` },
    fetch: async (input, init) => {
      const request = new Request(String(input).replace("/_vitehub/comments", "/api"), init)
      request.headers.set("sec-fetch-site", "same-origin")
      if (request.method !== "GET") request.headers.set("origin", consoleOrigin)
      return await handleHostedCommentsApi(request, { db })
    },
  })
}

async function joins(db: ConsoleDatabase, room: string, token: string | undefined, mode: "read" | "write" = "read"): Promise<string | false> {
  const { identify, authorize } = hostedCommentsRealtime(() => db)
  if (typeof authorize !== "function" || !identify) throw new TypeError("The hosted notice rooms identify and decide each join.")
  const query = token === undefined ? "" : `?${new URLSearchParams({ token })}`
  const request = new Request(`${consoleOrigin}/_vitehub/realtime/hosted-comments/${room.split("/").map(encodeURIComponent).join("/")}${query}`)
  // SAFETY: the notice rooms read only the request, the room, and the mode.
  const event = {} as RealtimeRequestEvent
  const user = await identify({ definition: "hosted-comments", request, event }) ?? null
  return user !== null && await authorize({ definition: "hosted-comments", documentId: room, mode, request, user, event }) && user.id
}

function dataOf<T>(result: { body: { data?: unknown } }): T {
  // SAFETY: each test reads the fields that the Comments API answers for its route.
  return result.body.data as T
}

describe("hosted Comments sign-in", () => {
  it("identifies the chosen project on linked sign-in return", async () => {
    const { db, portal } = await setup()
    const response = await authorize(db, portal, { userId: "u-ada", linked: true })
    const location = new URL(response.headers.get("location")!)
    expect(location.searchParams.get("vhp")).toBe(portal.id)
    expect(location.hash).toMatch(/^#vhc=[\w-]{43}$/)
  })
  it("sends a member back to the page with a one-time code, and gives the embed a token for its verifier", async () => {
    const { db, portal } = await setup()
    const { verifier, challenge } = await pkce()
    const authorized = await authorize(db, portal, { userId: "u-ada", challenge })
    expect(authorized.status).toBe(303)
    expect(authorized.headers.get("cache-control")).toBe("private, no-store")
    expect(authorized.headers.get("referrer-policy")).toBe("no-referrer")
    const location = new URL(authorized.headers.get("location")!)
    expect(`${location.origin}${location.pathname}${location.search}`).toBe("https://app.example.com/portal")
    expect(location.hash).toMatch(/^#vhc=[\w-]{43}$/)

    const redeemed = await redeem(db, portal.id, { code: codeOf(authorized), verifier })
    expect(redeemed.status).toBe(200)
    expect(redeemed.headers.get("cache-control")).toBe("private, no-store")
    expect(await redeemed.json()).toEqual({ token: expect.stringMatching(/^[\w-]{43}$/) })
    expect((await redeem(db, portal.id, { code: codeOf(authorized), verifier })).status).toBe(400)
  })

  it("sends the code only to the registered URL of the project", async () => {
    const { db, portal, other } = await setup()
    for (const target of ["https://app.example.com/portal", "https://app.example.com/portal/", "https://app.example.com/portal//"]) {
      expect((await authorize(db, portal, { userId: "u-ada", return: target })).headers.get("location"), target).toMatch(/^https:\/\/app\.example\.com\/portal#vhc=[\w-]{43}$/)
    }
    expect((await authorize(db, other, { userId: "u-eve", return: "https://other.example.com" })).headers.get("location")).toMatch(/^https:\/\/other\.example\.com\/#vhc=/)
    for (const target of [
      "https://app.example.com/portal/docs",
      "https://app.example.com/portal?next=https://evil.example",
      "https://app.example.com/portal?",
      "https://app.example.com/portal#",
      "https://app.example.com/portalx",
      "https://app.example.com/",
      "https://evil.example/portal",
      "http://app.example.com/portal",
      "https://ada:pw@app.example.com/portal",
      "/portal",
      "javascript:alert(1)",
      `${consoleOrigin}/comments/${portal.id}`,
      `${consoleOrigin}/comments/${other.id}`,
      `${consoleOrigin}/comments/${portal.id}/embed`,
    ]) {
      const refused = await authorize(db, portal, { userId: "u-ada", return: target })
      expect(refused.status, target).toBe(400)
      expect(await refused.text()).toContain("https://app.example.com/portal")
    }
    expect((await authorize(db, portal, { userId: "u-ada", challenge: "short" })).status).toBe(400)
    expect((await authorize(db, { ...portal, id: "missing" }, { userId: "u-ada" })).status).toBe(404)
    expect((await authorize(db, portal, { userId: "u-ada", headers: { "sec-fetch-mode": "cors" } })).status).toBe(403)
  })

  it("shows the sign-in page to a person without a session, and the switch page to an account outside the team", async () => {
    const { db, portal, count } = await setup()
    const signIn = await authorize(db, portal)
    expect(signIn.status).toBe(401)
    expect(signIn.headers.get("content-type")).toMatch(/^text\/html/)
    expect(await signIn.text()).toContain("data-site=\"app.example.com\" data-state=\"sign-in\"")
    const outsider = await authorize(db, portal, { userId: "u-eve" })
    expect(outsider.status).toBe(403)
    expect(await outsider.text()).toContain("data-state=\"forbidden\"")
    expect(await count("console_comment_sessions")).toBe(0)
  })

  it("signs a guest in with a hosted Comments pass, and refreshes the pass", async () => {
    const { db, portal, grant } = await setup()
    const cookie = await grant("g-live", ["comments-read", "comments-write", "console"])
    const authorized = await authorize(db, portal, { cookie })
    expect(authorized.status).toBe(303)
    expect(authorized.headers.get("set-cookie")).toMatch(new RegExp(`^__Host-vitehub-comments-pass-${portal.id}=pass-g-live-p+; Path=/; HttpOnly; SameSite=Lax; Max-Age=\\d+; Secure$`))
    for (const ended of [await grant("g-revoked", allRoles, { revokedAt: Date.now() }), await grant("g-expired", allRoles, { expiresAt: Date.now() - 1 }), await grant("g-console", ["console"])]) {
      expect((await authorize(db, portal, { cookie: ended })).status).toBe(401)
    }
    expect((await authorize(db, portal, { cookie: `${sitePassCookie(portal.id, true, "comments")}=unknown` })).status).toBe(401)
    expect((await authorize(db, portal, { cookie: cookie.replace(`-${portal.id}=`, "-other=") })).status).toBe(401)
  })

  it("uses a code once, for its project, its verifier, and 2 minutes", async () => {
    const { db, portal, other } = await setup()
    const now = Date.now()
    const issue = async () => {
      const keys = await pkce()
      return { ...keys, code: codeOf(await authorize(db, portal, { userId: "u-ada", challenge: keys.challenge, now })) }
    }
    const twice = await issue()
    const answers = await Promise.all([redeem(db, portal.id, twice), redeem(db, portal.id, twice)])
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 400])

    const wrong = await issue()
    const mismatch = await redeem(db, portal.id, { code: wrong.code, verifier: (await pkce()).verifier })
    expect(await mismatch.json()).toMatchObject({ error: { code: "CONSOLE_HOSTED_COMMENTS_CODE_INVALID" } })
    expect((await redeem(db, portal.id, wrong)).status).toBe(200)

    const elsewhere = await issue()
    expect((await redeem(db, other.id, elsewhere)).status).toBe(400)
    expect((await redeem(db, portal.id, elsewhere)).status).toBe(200)

    const late = await issue()
    expect((await redeem(db, portal.id, late, { now: now + 2 * 60_000 })).status).toBe(400)
    expect((await redeem(db, portal.id, { code: (await issue()).code, verifier: "short" })).status).toBe(400)
  })

  it("redeems only from the Console origin, without cookies, with a JSON body", async () => {
    const { db, portal } = await setup()
    const keys = await pkce()
    const code = codeOf(await authorize(db, portal, { userId: "u-ada", challenge: keys.challenge }))
    const body = { code, verifier: keys.verifier }
    const refusals: Record<string, string>[] = [{ cookie: "better-auth.session_token=x" }, { "origin": "https://app.example.com" }, { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }]
    for (const headers of refusals) {
      const refused = await redeem(db, portal.id, body, { headers })
      expect(refused.status).toBeGreaterThanOrEqual(403)
      expect(await refused.json()).toMatchObject({ error: { code: "CONSOLE_HOSTED_COMMENTS_REQUEST_REFUSED" } })
    }
    expect((await redeemHostedComments(new Request(`${consoleOrigin}/comments/${portal.id}/redeem`), { db })).status).toBe(405)
    expect((await redeem(db, portal.id, body)).status).toBe(200)
  })

  it("gives no token when the person lost access between the sign-in and the redeem", async () => {
    const { db, portal, join, leave, count } = await setup()
    await join("u-bob")
    const keys = await pkce()
    const code = codeOf(await authorize(db, portal, { userId: "u-bob", challenge: keys.challenge }))
    await leave("u-bob")
    expect(await (await redeem(db, portal.id, { code, verifier: keys.verifier })).json()).toMatchObject({ error: { code: "CONSOLE_HOSTED_COMMENTS_ACCESS_ENDED" } })
    expect(await count("console_comment_sessions")).toBe(0)
  })
})

describe("hosted Comments API", () => {
  it("creates, reads, replies to, and resolves a thread of a member through the embed transport", async () => {
    const { db, portal } = await setup()
    const comments = embed(db, portal, await signIn(db, portal, { userId: "u-ada" }))
    const subject = { kind: "page", id: "/portal/docs" }
    const created = await comments.create({ subject, anchor, body: "Typo here" })
    expect(created).toMatchObject({ n: 1, scope: "site", author: { id: "u-ada", name: "Ada" } })
    expect((await comments.list({ subject })).map(thread => thread.id)).toEqual([created.id])
    expect(await comments.reply({ threadId: created.id, body: "Fixed" })).toMatchObject({ messages: [{ body: "Typo here" }, { body: "Fixed" }] })
    expect(await comments.resolve({ threadId: created.id })).toMatchObject({ status: "resolved" })
    expect(await comments.get({ scope: "site", n: 1 })).toMatchObject({ id: created.id })
    expect(await comments.reopen({ threadId: created.id })).toMatchObject({ status: "open" })
  })

  it("answers the session of the page with no-store, and only the routes of the overlay", async () => {
    const { db, portal } = await setup()
    const token = await signIn(db, portal, { userId: "u-ada" })
    const session = await call(db, portal.id, token, "/session?page=/portal/docs")
    expect(session.body.data).toMatchObject({ attachments: false, can: { comment: true }, user: { id: "u-ada", name: "Ada" } })
    expect(session.headers.get("cache-control")).toBe("private, no-store")
    for (const [method, path] of [["POST", "/attachments"], ["GET", "/files/x"], ["POST", "/send/pair"], ["GET", "/mcp"], ["PUT", "/threads"], ["GET", ""], ["GET", "/../authorize"]] as const) {
      const refused = await call(db, portal.id, token, path, { method, ...(method === "GET" ? {} : { json: {} }) })
      expect(refused.status, `${method} ${path}`).toBe(404)
    }
  })

  it("keeps the tokens and threads of each project apart", async () => {
    const { db, portal, other } = await setup()
    const ada = await signIn(db, portal, { userId: "u-ada" })
    const eve = await signIn(db, other, { userId: "u-eve" })
    const mine = dataOf<{ id: string }>(await call(db, portal.id, ada, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "Portal" } }))
    const theirs = dataOf<{ id: string, n: number }>(await call(db, other.id, eve, "/threads", { method: "POST", json: { page: "/", anchor, body: "Other" } }))
    expect(theirs.n).toBe(1)
    expect((await call(db, other.id, eve, `/threads/${mine.id}`)).body.data).toBeNull()
    expect((await call(db, other.id, eve, `/threads/${mine.id}/comments`, { method: "POST", json: { body: "Hi" } })).status).toBe(404)
    expect((await call(db, other.id, eve, `/threads/${mine.id}`, { method: "DELETE" })).status).toBe(404)
    expect(dataOf<{ id: string }[]>(await call(db, other.id, eve, "/threads")).map(thread => thread.id)).toEqual([theirs.id])
    expect(await call(db, portal.id, eve, "/threads?page=/portal/docs")).toMatchObject({ status: 401, body: { error: { code: "CONSOLE_HOSTED_COMMENTS_TOKEN_INVALID" } } })
    expect((await call(db, other.id, ada, "/threads")).status).toBe(401)
  })

  it("lets a guest act with the comment roles of a live pass only, and ends the session when the pass ends", async () => {
    const { db, portal, grant, count } = await setup()
    const guest = await signIn(db, portal, { cookie: await grant("g-live", ["comments-read", "comments-write"]) })
    const created = await call(db, portal.id, guest, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "Guest" } })
    const { id, author, messages: [first] } = dataOf<{ id: string, author: unknown, messages: [{ id: string }] }>(created)
    expect(author).toMatchObject({ id: "guest:g-live", name: "Grace", guest: true })
    expect((await call(db, portal.id, guest, `/threads/${id}/comments`, { method: "POST", json: { body: "Guest reply" } })).status).toBe(200)
    expect((await call(db, portal.id, guest, `/threads/${id}`, { method: "DELETE" })).status).toBe(404)
    expect((await call(db, portal.id, guest, `/threads/${id}/resolve`, { method: "POST" })).body.error?.code).toBe("COMMENTS_FORBIDDEN")
    expect((await call(db, portal.id, guest, `/threads/${id}/comments/${first.id}`, { method: "DELETE" })).status).toBe(404)

    const reader = await signIn(db, portal, { cookie: await grant("g-reader", ["comments-read"]) })
    expect((await call(db, portal.id, reader, `/threads/${id}/comments`, { method: "POST", json: { body: "No" } })).status).toBe(403)

    expect(await createConsoleSiteStore(db, portal.id, "comments").revoke("g-live")).toEqual({ kind: "guest" })
    expect((await call(db, portal.id, guest, "/threads?page=/portal/docs")).body.error?.code).toBe("CONSOLE_HOSTED_COMMENTS_ACCESS_ENDED")
    expect((await call(db, portal.id, guest, "/threads?page=/portal/docs")).body.error?.code).toBe("CONSOLE_HOSTED_COMMENTS_TOKEN_INVALID")
    expect(await count("console_comment_sessions")).toBe(1)
  })

  it("ends the session of a guest whose inviter left the team, and of a member who left", async () => {
    const { db, portal, grant, join, leave } = await setup()
    await join("u-bob")
    const guest = await signIn(db, portal, { cookie: await grant("g-bob", allRoles, { createdBy: "u-bob" }) })
    const bob = await signIn(db, portal, { userId: "u-bob" })
    expect((await call(db, portal.id, guest, "/threads")).status).toBe(200)
    expect((await call(db, portal.id, bob, "/threads")).status).toBe(200)
    await leave("u-bob")
    expect((await call(db, portal.id, guest, "/threads")).body.error?.code).toBe("CONSOLE_HOSTED_COMMENTS_ACCESS_ENDED")
    expect((await call(db, portal.id, bob, "/threads")).body.error?.code).toBe("CONSOLE_HOSTED_COMMENTS_ACCESS_ENDED")
  })

  it("accepts a token for 12 hours", async () => {
    const { db, portal } = await setup()
    const now = Date.now()
    const token = await signIn(db, portal, { userId: "u-ada", now })
    expect((await call(db, portal.id, token, "/threads", { now: now + 12 * 3_600_000 - 1 })).status).toBe(200)
    expect((await call(db, portal.id, token, "/threads", { now: now + 12 * 3_600_000 })).body.error?.code).toBe("CONSOLE_HOSTED_COMMENTS_TOKEN_INVALID")
    expect((await call(db, portal.id, undefined, "/threads")).status).toBe(401)
    expect((await call(db, portal.id, "x".repeat(43), "/threads")).status).toBe(401)
  })

  it("refuses cookies, other origins, other bodies, and pages outside the project", async () => {
    const { db, portal } = await setup()
    const token = await signIn(db, portal, { userId: "u-ada" })
    const create = { method: "POST", json: { page: "/portal/docs", anchor, body: "Hi" } }
    const refusals: Record<string, string>[] = [{ cookie: "better-auth.session_token=x" }, { "sec-fetch-site": "cross-site" }, { origin: "https://app.example.com" }, { origin: "null" }]
    for (const headers of refusals) {
      expect((await call(db, portal.id, token, "/threads", { ...create, headers })).body.error?.code).toBe("CONSOLE_HOSTED_COMMENTS_REQUEST_REFUSED")
    }
    expect((await call(db, portal.id, token, "/threads", { ...create, headers: { origin: consoleOrigin, "sec-fetch-site": "same-origin" } })).status).toBe(200)
    const plain = new Request(`${consoleOrigin}/comments/${portal.id}/api/threads`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" }, body: "Hi" })
    expect((await handleHostedCommentsApi(plain, { db })).status).toBe(415)

    expect((await call(db, portal.id, token, "/threads", { method: "POST", json: { page: "/elsewhere", anchor, body: "Hi" } })).body.error?.code).toBe("COMMENTS_FORBIDDEN")
    expect((await call(db, portal.id, token, "/threads", { method: "POST", json: { subject: { kind: "content", id: "docs/1" }, anchor, body: "Hi" } })).body.error?.code).toBe("COMMENTS_FORBIDDEN")
    const spoofed = await call(db, portal.id, token, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "Hi", context: { url: "https://evil.example/portal/docs" } }, headers: { "x-forwarded-host": "evil.example" } })
    expect(spoofed.body.error?.code).toBe("COMMENTS_INVALID_INPUT")
  })

  it("deletes the threads, messages, and sessions of a project when the team unlinks it", async () => {
    const { db, portal, count } = await setup()
    const token = await signIn(db, portal, { userId: "u-ada" })
    const created = dataOf<{ id: string }>(await call(db, portal.id, token, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "Gone soon" } }))
    await call(db, portal.id, token, `/threads/${created.id}/comments`, { method: "POST", json: { body: "Reply" } })
    expect(await count("console_comment_messages")).toBe(2)
    expect(await createConsoleProjectStore(db, secret, "t-ada").remove(portal.id)).toBe(true)
    for (const table of ["console_comment_threads", "console_comment_messages", "console_comment_counters", "console_comment_sessions"]) {
      expect(await count(table)).toBe(0)
    }
    expect((await call(db, portal.id, token, "/threads")).status).toBe(404)
  })
})

describe("hosted Comments notices", () => {
  it("tells each open page of the project when one of its threads changes", async () => {
    const { db, portal, other } = await setup()
    const ada = await signIn(db, portal, { userId: "u-ada" })
    const eve = await signIn(db, other, { userId: "u-eve" })
    const adaSession = await joins(db, hostedCommentNoticeRoom(portal.id), ada)
    const page = { kind: "page", id: "/portal/docs" }
    const created = dataOf<{ id: string }>(await call(db, portal.id, ada, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "Typo" } }))
    expect((await call(db, portal.id, ada, `/threads/${created.id}/comments`, { method: "POST", json: { body: "Fixed" } })).status).toBe(200)
    expect((await call(db, portal.id, ada, `/threads/${created.id}/resolve`, { method: "POST" })).status).toBe(200)
    await vi.waitFor(() => expect(notices).toHaveLength(3))
    expect(notices).toEqual(Array.from({ length: 3 }, () => ({ definition: "hosted-comments", room: hostedCommentNoticeRoom(portal.id), body: { type: "comments", subject: page }, user: adaSession })))

    notices.length = 0
    expect((await call(db, other.id, eve, "/threads", { method: "POST", json: { page: "/", anchor, body: "Other" } })).status).toBe(200)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]).toMatchObject({ room: hostedCommentNoticeRoom(other.id), user: await joins(db, hostedCommentNoticeRoom(other.id), eve) })
  })

  it("lets a page join the notice room of its own project only, with a live token that may read", async () => {
    const { db, portal, other, grant, leave } = await setup()
    const ada = await signIn(db, portal, { userId: "u-ada" })
    const eve = await signIn(db, other, { userId: "u-eve" })
    const portalRoom = hostedCommentNoticeRoom(portal.id)
    const otherRoom = hostedCommentNoticeRoom(other.id)
    expect(await joins(db, portalRoom, ada)).toEqual(expect.any(String))
    expect(await joins(db, otherRoom, eve)).toEqual(expect.any(String))
    expect(await joins(db, otherRoom, ada)).toBe(false)
    expect(await joins(db, portalRoom, eve)).toBe(false)
    expect(await joins(db, portalRoom, undefined)).toBe(false)
    expect(await joins(db, portalRoom, "x".repeat(43))).toBe(false)
    expect(await joins(db, portalRoom, ada, "write")).toBe(false)
    for (const room of [`projects/${portal.id}/subjects/x`, `projects/${other.id}/../${portal.id}`, "projects", "subjects/x"]) {
      expect(await joins(db, room, ada), room).toBe(false)
    }

    const guest = await signIn(db, portal, { cookie: await grant("g-reader", ["comments-read"]) })
    expect(await joins(db, portalRoom, guest)).toEqual(expect.any(String))
    await createConsoleSiteStore(db, portal.id, "comments").revoke("g-reader")
    expect(await joins(db, portalRoom, guest)).toBe(false)
    await leave("u-ada")
    expect(await joins(db, portalRoom, ada)).toBe(false)
  })

  it("sends no notice to a token after its expiry, and tells its page that the session ended", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { db, portal, count } = await setup()
    const room = hostedCommentNoticeRoom(portal.id)
    const start = Date.now()
    const early = await signIn(db, portal, { userId: "u-ada" })
    const earlySession = await joins(db, room, early)
    vi.setSystemTime(start + 11 * 3_600_000)
    const late = await signIn(db, portal, { userId: "u-ada" })
    const lateSession = await joins(db, room, late)
    vi.setSystemTime(start + 12 * 3_600_000)

    expect((await call(db, portal.id, late, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "Late" } })).status).toBe(200)
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(notices.filter(notice => notice.user === earlySession).map(notice => notice.body)).toEqual([{ type: "ended" }])
    expect(notices.filter(notice => notice.user === lateSession).map(notice => notice.body)).toEqual([{ type: "comments", subject: { kind: "page", id: "/portal/docs" } }])
    expect(await joins(db, room, early)).toBe(false)
    expect(await count("console_comment_sessions")).toBe(1)
  })

  it("ends a token that expires while the Console checks its access, and sends it no notice", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { db, portal, grant, join } = await setup()
    await join("u-bob")
    const room = hostedCommentNoticeRoom(portal.id)
    const start = Date.now()
    const guest = await signIn(db, portal, { cookie: await grant("g-bob", allRoles, { createdBy: "u-bob" }) })
    const guestSession = await joins(db, room, guest)
    vi.setSystemTime(start + 3_600_000)
    const ada = await signIn(db, portal, { userId: "u-ada" })
    const adaSession = await joins(db, room, ada)
    vi.setSystemTime(start + 12 * 3_600_000 - 1)
    memberReads.before = (userId) => {
      if (userId === "u-bob") vi.setSystemTime(start + 12 * 3_600_000)
    }

    expect((await call(db, portal.id, ada, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "Now" } })).status).toBe(200)
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(notices.filter(notice => notice.user === guestSession).map(notice => notice.body)).toEqual([{ type: "ended" }])
    expect(notices.filter(notice => notice.user === adaSession).map(notice => notice.body)).toEqual([{ type: "comments", subject: { kind: "page", id: "/portal/docs" } }])
  })

  it("sends no notice to the open page of a revoked guest, ends its session, and tells the page to close", async () => {
    const { db, portal, grant, count } = await setup()
    const room = hostedCommentNoticeRoom(portal.id)
    const ada = await signIn(db, portal, { userId: "u-ada" })
    const guest = await signIn(db, portal, { cookie: await grant("g-reader", ["comments-read"]) })
    const adaSession = await joins(db, room, ada)
    const guestSession = await joins(db, room, guest)
    expect(guestSession).toEqual(expect.any(String))
    await createConsoleSiteStore(db, portal.id, "comments").revoke("g-reader")

    expect((await call(db, portal.id, ada, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "After" } })).status).toBe(200)
    await vi.waitFor(() => expect(notices).toHaveLength(2))
    expect(notices.filter(notice => notice.user === guestSession).map(notice => notice.body)).toEqual([{ type: "ended" }])
    expect(notices.filter(notice => notice.user === adaSession).map(notice => notice.body)).toEqual([{ type: "comments", subject: { kind: "page", id: "/portal/docs" } }])
    expect(await joins(db, room, guest)).toBe(false)
    expect(await count("console_comment_sessions")).toBe(1)

    notices.length = 0
    expect((await call(db, portal.id, ada, "/threads", { method: "POST", json: { page: "/portal/docs", anchor, body: "Again" } })).status).toBe(200)
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    expect(notices[0]!.user).toBe(adaSession)
  })
})
