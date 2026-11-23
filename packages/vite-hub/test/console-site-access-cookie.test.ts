import { DatabaseSync } from "node:sqlite"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineRelations } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { installRequestStandardContext, installStandardContext } from "@vite-hub/runtime/internal/h3"

import { commentsRoleAllows, defineComments } from "../../comments/src/index.ts"
import { defineCommentsPlugin } from "../../comments/src/runtime/plugin.ts"
import { resolveCommentsIdentity } from "../../comments/src/runtime/session.ts"
import { runWithDatabaseRequest } from "../../database/src/runtime/d1-sessions.ts"
import { createDrizzleSqliteAdapter } from "../../database/src/runtime/drizzle-adapter.ts"
import { normalizeKVOptions } from "../../kv/src/config.ts"
import createDatabaseKVDriver, { kvSqlClientFromDatabase } from "../../kv/src/runtime/database.ts"
import { consoleState } from "../src/console/internal.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import consoleRpcRoute from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { installConsoleSiteDatabase } from "../src/console/runtime/server/setup.ts"
import { readConsoleSiteVisitor } from "../src/console/runtime/server/site-session.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"
import type { CommentsUser } from "../../comments/src/index.ts"
import type { CommentsRequestEvent } from "../../comments/src/types.ts"

/** The app's default KV store: a map with TTLs, whose `getAndDelete()` takes a key out once, as Redis does. */
const kv = vi.hoisted(() => {
  const entries = new Map<string, { value: string, expiresAt: number }>()
  const live = (key: string) => {
    const entry = entries.get(key)
    return entry && entry.expiresAt > Date.now() ? entry.value : null
  }
  return {
    driver: "redis",
    entries,
    store: {
      async set(key: string, value: string, options: { ttl: number }) {
        entries.set(key, { value, expiresAt: Date.now() + options.ttl * 1000 })
        return [undefined, undefined] as const
      },
      async get(key: string) {
        return [undefined, live(key)] as const
      },
      async getAndDelete(key: string) {
        const value = live(key)
        entries.delete(key)
        return [undefined, value] as const
      },
      async list({ prefix }: { prefix: string }) {
        // Redis lists keys with `:`; some drivers use `/`.
        return [undefined, { keys: [...entries.keys()].filter(key => key.startsWith(prefix) && live(key) !== null).map(key => key.replaceAll(":", "/")) }] as const
      },
      async delete(key: string) {
        entries.delete(key)
        return [undefined, undefined] as const
      },
    },
  }
})
vi.mock("@vite-hub/kv", () => ({ getKVStoreDriver: async () => kv.driver, kv: kv.store }))

const origin = "https://app.example.com"
const ada: ConsoleCallerUser = { email: "Ada@Example.com", id: "console-ada", name: "Ada" }
const key = await consoleTestKey("CONSOLE_SITE")
const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
const secret = "a-root-secret-of-at-least-32-characters"
let nitroApp: object

async function call(name: string, input: Record<string, unknown> = {}, user: ConsoleCallerUser = ada): Promise<{ status: number, value: unknown, body: unknown }> {
  const response = await handleConsoleRpcRequest(await signedRpcRequest({ caller: { user, via: "console" }, input, key: key.key, operation: name, url: `${origin}/_vitehub/rpc` }))
  const body: unknown = await operationRpcResponseResult(response)
  return { status: response.status, value: Reflect.get(Object(body), "value"), body }
}

async function link(name: string, input: Record<string, unknown> = {}): Promise<string> {
  const { value, body } = await call(name, input)
  const url: unknown = Reflect.get(Object(value), "url")
  if (String(url) !== url) throw new Error(`No link: ${JSON.stringify(body)}`)
  return url
}

/** Opens a one-time link in a browser, and returns the redirect and the Site access cookie it set. */
async function open(url: string): Promise<{ response: Response, cookie: string }> {
  const response = await consoleRpcRoute.fetch(new Request(url, { headers: { "user-agent": chrome } }))
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]!).find(pair => pair.startsWith("vitehub_site=")) ?? ""
  return { response, cookie }
}

/** The page tools that the session route gives this browser. */
async function tools(cookie: string): Promise<string[]> {
  const response = await respondViteHubPageSession(nitroApp, new Request(`${origin}/_vitehub/page/tools?page=%2Fguide`, { headers: { cookie } }))
  const body: unknown = await response.json()
  return (Reflect.get(Object(body), "tools") as Array<{ id: string }>).map(tool => tool.id)
}

/** The person that Comments resolves for this browser. */
async function commentsUser(cookie: string): Promise<CommentsUser | null> {
  const request = new Request(`${origin}/_vitehub/comments/session`, { headers: { cookie } })
  installRequestStandardContext(request)
  // SAFETY: The line above installed the Standard Context of this Request, as Nitro does for a route.
  return (await resolveCommentsIdentity(defineComments(), request as Request & CommentsRequestEvent)).user
}

beforeEach(() => {
  kv.entries.clear()
  kv.driver = "redis"
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
  vi.stubEnv("VITEHUB_SECRET", secret)
  // An app without Auth, with a default KV store. The Console is not a development server.
  installConsoleSections("console-site-cookie", ["site", "kv"])
  installConsoleAccess({ mode: "token" })
  nitroApp = {}
  installConsolePageTool(nitroApp, { script: "/console.js", site: readConsoleSiteVisitor })
  defineCommentsPlugin({ comments: defineComments(), database: () => undefined, overlay: "/comments.js" })(nitroApp)
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  consoleState().siteDatabase = undefined
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("Site access without Auth", () => {
  it("signs a member in with a sealed cookie that shows the Console link and Comments", async () => {
    expect(await tools("")).toEqual([])
    const url = await link("site.link", { path: "/guide" })
    const { response, cookie } = await open(url)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${origin}/guide?vitehub`)
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(/^vitehub_site=[a-f0-9]{24}:[a-f0-9]+; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure$/),
      "vitehub_session=1; Path=/; SameSite=Lax; Max-Age=604800",
      "vitehub-tools=; Path=/; Max-Age=0; SameSite=Lax",
    ])
    // The browser sees only the sealed value, not the person or the roles.
    expect(cookie).toMatch(/^vitehub_site=[a-f0-9]{24}:[a-f0-9]+$/)
    expect(await tools(cookie)).toEqual(["console", "comments"])
    const user = await commentsUser(cookie)
    expect(user).toEqual({ id: "console-ada", name: "Ada", email: "ada@example.com", role: "console,comments-read,comments-write,comments-resolve,comments-delete" })
    expect(commentsRoleAllows(user, "delete")).toBe(true)
    // The link works once.
    expect((await open(url)).response.status).toBe(401)
  })

  it("ignores a changed cookie, a cookie of another secret, and an expired cookie", async () => {
    const { cookie } = await open(await link("site.link"))
    const last = cookie.at(-1) === "0" ? "1" : "0"
    expect(await tools(`${cookie.slice(0, -1)}${last}`)).toEqual([])
    vi.stubEnv("VITEHUB_SECRET", `${secret}-rotated`)
    expect(await tools(cookie)).toEqual([])
    vi.stubEnv("VITEHUB_SECRET", secret)
    expect(await tools(cookie)).toEqual(["console", "comments"])
    vi.useFakeTimers({ now: Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000 })
    expect(await tools(cookie)).toEqual([])
    expect(await commentsUser(cookie)).toBeNull()
  })

  it("lists the browser, and revoking it signs the browser out", async () => {
    const { cookie } = await open(await link("site.link"))
    const { value } = await call("site.sessions")
    expect(value).toEqual({ sessions: [expect.objectContaining({ kind: "member", person: { id: "console-ada", name: "Ada", email: "ada@example.com" }, grants: ["console", "comments-read", "comments-write", "comments-resolve", "comments-delete"], device: "Chrome · macOS" })] })
    const id = String(Reflect.get(Object((value as { sessions: unknown[] }).sessions[0]), "id"))
    expect((await call("site.revoke-session", { id })).value).toEqual({ revoked: true, removedUser: false })
    expect(await tools(cookie)).toEqual([])
    expect(await commentsUser(cookie)).toBeNull()
    expect((await call("site.sessions")).value).toEqual({ sessions: [] })
  })

  it("signs a guest in with the roles of the invite, never the Console", async () => {
    const { value } = await call("site.invite", { name: "Ana", grants: ["comments-write"] })
    expect((await call("site.invites")).value).toEqual({ invites: [expect.objectContaining({ name: "Ana", grants: ["comments-write"], path: "/" })] })
    const { cookie } = await open(String(Reflect.get(Object(value), "url")))
    expect(await tools(cookie)).toEqual(["comments"])
    const user = await commentsUser(cookie)
    expect(user).toMatchObject({ name: "Ana", role: "guest,comments-write" })
    expect([commentsRoleAllows(user, "write"), commentsRoleAllows(user, "delete")]).toEqual([true, false])
    expect((await call("site.invites")).value).toEqual({ invites: [] })
  })
})

function createD1() {
  const sqlite = new DatabaseSync(":memory:")
  const replica = new DatabaseSync(":memory:")
  let remaining = Infinity
  const statement = (connection: DatabaseSync, query: string, params: (string | number | null)[] = []) => ({
    bind: (...values: (string | number | null)[]) => {
      if (values.length > 100) throw new Error("D1 bind limit exceeded")
      return statement(connection, query, values)
    },
    all: async () => {
      if (--remaining < 0) throw new Error("D1 query limit exceeded")
      return { results: connection.prepare(query).all(...params), success: true, meta: {} }
    },
    raw: async () => connection.prepare(query).all(...params).map(row => Object.values(row)),
    run: async () => ({ results: [], success: true, meta: connection.prepare(query).run(...params) }),
  })
  const rows = () => Number(sqlite.prepare("select count(*) as count from vitehub_console_site").get()?.count)
  const client = (connection: DatabaseSync) => ({ prepare: (query: string) => statement(connection, query), batch: async () => [] })
  const withSession = vi.fn((_constraint: string) => ({ ...client(replica), getBookmark: () => "stale" }))
  const snapshot = () => {
    replica.exec(String(sqlite.prepare("select sql from sqlite_master where name = 'vitehub_console_site'").get()?.sql))
    const insert = replica.prepare("insert into vitehub_console_site (namespace, key, value, expires_at) values (?, ?, ?, ?)")
    for (const row of sqlite.prepare("select namespace, key, value, expires_at from vitehub_console_site").all()) {
      insert.run(row.namespace!, row.key!, row.value!, row.expires_at ?? null)
    }
  }
  const close = () => {
    replica.close()
    sqlite.close()
  }
  return { binding: { ...client(sqlite), withSession }, rows, snapshot, close, limit: (queries: number) => { remaining = queries } }
}

describe("Site access without Auth on Cloudflare KV and a D1 Database", () => {
  let d1: ReturnType<typeof createD1>
  let db: object

  beforeEach(({ onTestFinished }) => {
    kv.driver = "cloudflare"
    d1 = createD1()
    onTestFinished(d1.close)
    db = createDrizzleSqliteAdapter({ name: "default", cloudflare: { binding: "DB", readReplication: true } }, defineRelations({}), { missingConnection: "a D1 binding", requireRemoteUrl: true })
    installConsoleSiteDatabase(async () => ({ default: { db } }), "default")
  })

  const inD1 = <T>(callback: () => T) => runWithActiveCloudflareEnv({ DB: d1.binding }, callback)

  it("keeps one-time links and site sessions in the Database without enabling inspection", () => inD1(async () => {
    const url = await link("site.link", { path: "/guide" })
    expect(d1.rows()).toBe(1)
    const { response, cookie } = await open(url)
    expect(response.status).toBe(303)
    expect(await tools(cookie)).toEqual(["console", "comments"])
    expect(consoleState().database).toBeUndefined()
    expect((await open(url)).response.status).toBe(401)
    const { value } = await call("site.sessions")
    const id = String(Reflect.get(Object((value as { sessions: unknown[] }).sessions[0]), "id"))
    expect((await call("site.revoke-session", { id })).value).toEqual({ revoked: true, removedUser: false })
    expect(await tools(cookie)).toEqual([])
    expect(kv.entries.size).toBe(0)
  }))

  it("keeps links and site sessions out of reach of a KV store with the same name on the same Database", () => inD1(async () => {
    const url = await link("site.link")
    const { cookie } = await open(await link("site.link"))
    const stores = normalizeKVOptions({ stores: { "default": { driver: "database" }, "vitehub-console-site": { driver: "database" } } })?.stores ?? {}
    const store = stores["vitehub-console-site"]
    if (store?.driver !== "database") throw new Error("No database KV store")
    const app = createDatabaseKVDriver(store, async () => kvSqlClientFromDatabase(db, "default"))
    expect(await app.getKeys("", {})).toEqual([])
    await app.clear?.("", {})
    expect(d1.rows()).toBe(2)
    expect(await tools(cookie)).toEqual(["console", "comments"])
    expect((await open(url)).response.status).toBe(303)
  }))

  it("opens a link once when two browsers open it at the same time", () => inD1(async () => {
    const url = await link("site.link")
    const statuses = (await Promise.all([open(url), open(url)])).map(({ response }) => response.status)
    expect(statuses.sort()).toEqual([303, 401])
  }))

  it("reads the primary when a browser's D1 replica still has a revoked session", () => inD1(async () => {
    const { cookie } = await open(await link("site.link"))
    const { value } = await call("site.sessions")
    const { sessions } = value as { sessions: { id: string }[] }
    d1.snapshot()
    expect((await call("site.revoke-session", { id: sessions[0]!.id })).value).toEqual({ revoked: true, removedUser: false })

    const event = { req: new Request(origin, { headers: { cookie } }), res: { headers: new Headers() } }
    installStandardContext(event)
    await runWithDatabaseRequest(event, async () => {
      expect(await tools(cookie)).toEqual([])
      expect(await commentsUser(cookie)).toBeNull()
    })
    expect(d1.binding.withSession).not.toHaveBeenCalled()
  }))

  it("lists sessions and lists and revokes invites within a D1 request's query budget", () => inD1(async () => {
    for (let index = 0; index < 101; index++) {
      expect((await open(await link("site.link"))).response.status).toBe(303)
      await link("site.invite", { name: `Guest ${index}`, grants: ["comments-write"] })
    }
    d1.limit(50)
    const { value: sessionList } = await call("site.sessions")
    expect(Reflect.get(Object(sessionList), "sessions")).toHaveLength(101)
    d1.limit(50)
    const { value } = await call("site.invites")
    const { invites } = value as { invites: { id: string }[] }
    expect(invites).toHaveLength(101)
    d1.limit(50)
    expect((await call("site.revoke-invite", { id: invites[0]!.id })).value).toEqual({ revoked: true })
  }))
})

function createD1HttpApiOverSqlite(rows: "objects" | "arrays") {
  const sqlite = new DatabaseSync(":memory:")
  const request = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const { sql, params } = JSON.parse(String(init?.body)) as { sql: string, params: (string | number | null)[] }
    if (params.length > 100) return Response.json({ success: false, errors: [{ message: "too many SQL variables" }] }, { status: 400 })
    const statement = sqlite.prepare(sql)
    const found = statement.all(...params)
    const results = rows === "objects" ? found : { columns: statement.columns().map(column => column.name), rows: found.map(row => Object.values(row)) }
    return Response.json({ success: true, result: [{ success: true, results }] })
  })
  return { request, sqlite }
}

describe.each(["objects", "arrays"] as const)("Site access without Auth on fs-lite KV and a D1 Database over HTTP with rows as %s", (rows) => {
  it("keeps one-time links and site sessions in the Database through the D1 HTTP API", async ({ onTestFinished }) => {
    kv.driver = "fs-lite"
    const api = createD1HttpApiOverSqlite(rows)
    onTestFinished(() => api.sqlite.close())
    vi.stubGlobal("fetch", api.request)
    onTestFinished(() => {
      vi.unstubAllGlobals()
    })
    const db = createDrizzleSqliteAdapter({ name: "default", cloudflare: { databaseId: "site-id", http: { url: "https://d1.example.com/query", authToken: "token" } } }, defineRelations({}), { missingConnection: "a D1 binding", requireRemoteUrl: true })
    installConsoleSiteDatabase(async () => ({ default: { db } }), "default")

    const url = await link("site.link", { path: "/guide" })
    expect(api.sqlite.prepare("select count(*) as count from vitehub_console_site").get()?.count).toBe(1)
    const { response, cookie } = await open(url)
    expect(response.status).toBe(303)
    expect(await tools(cookie)).toEqual(["console", "comments"])
    expect((await open(url)).response.status).toBe(401)
    for (let index = 0; index < 101; index++) await link("site.invite", { name: `Guest ${index}`, grants: ["comments-write"] })
    expect(Reflect.get(Object((await call("site.invites")).value), "invites")).toHaveLength(101)
    const { value } = await call("site.sessions")
    const id = String(Reflect.get(Object((value as { sessions: unknown[] }).sessions[0]), "id"))
    expect((await call("site.revoke-session", { id })).value).toEqual({ revoked: true, removedUser: false })
    expect(await tools(cookie)).toEqual([])
    expect(kv.entries.size).toBe(0)
  })
})

it("generates the Site storage loader when Database inspection is hidden", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-console-site-database-"))
  try {
    const file = join(root, "plugin.mjs")
    await writeConsoleNitroPlugin({ file, projectRoot: root, sections: ["kv", "databases"], catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token", hiddenSections: ["databases"] }, pageTool: { base: "/" } })
    const plugin = await readFile(file, "utf8")
    expect(plugin).toContain('installConsoleSiteDatabase(async () => (await import("@vite-hub/database/runtime/registry")).databases)')
    expect(plugin).not.toContain("installConsoleDatabase")
    expect(plugin).toContain(' ["kv","site"])')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe("Site access without Auth fails closed", () => {
  it("refuses a link without a KV store that takes a link out once", async () => {
    kv.driver = "cloudflare-kv-binding"
    expect((await call("site.link")).body).toMatchObject({ code: "CONSOLE_TICKET_STORE_MISSING", fix: expect.stringContaining("add a Database") })
    installConsoleSections("console-site-cookie", ["site"])
    expect((await call("site.link")).body).toMatchObject({ code: "CONSOLE_TICKET_STORE_MISSING" })
    expect(kv.entries.size).toBe(0)
  })

  it("refuses a link without VITEHUB_SECRET", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    expect((await call("site.link")).body).toMatchObject({ code: "CONSOLE_SITE_SECRET_MISSING", fix: expect.stringContaining("openssl rand -base64 32") })
    expect(kv.entries.size).toBe(0)
  })
})
