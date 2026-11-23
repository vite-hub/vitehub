import { execFile } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { defineRelations } from "drizzle-orm"
import { resolveConfig } from "vite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { hubDatabase } from "@vite-hub/database/vite"
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
import { resolveConsoleOptions, resolveGeneratedConsolePlugin } from "../src/console/vite.ts"
import { vitehub } from "../src/index.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import consoleRpcRoute from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { installConsoleSiteDatabase } from "../src/console/runtime/server/setup.ts"
import { readConsoleSiteVisitor } from "../src/console/runtime/server/site-session.ts"
import { describeConsoleSiteStore } from "../src/console/runtime/server/tickets.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { createProject } from "./support/content-cms.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"
import type { CommentsUser } from "../../comments/src/index.ts"
import type { CommentsRequestEvent } from "../../comments/src/types.ts"
import type { ConsoleSectionId } from "../src/console/runtime/sections.ts"

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

async function open(url: string): Promise<{ response: Response, cookie: string }> {
  const response = await consoleRpcRoute.fetch(new Request(url, { headers: { "user-agent": chrome } }))
  const cookie = response.headers.getSetCookie().map(value => value.split(";")[0]!).find(pair => pair.startsWith("vitehub_site=")) ?? ""
  return { response, cookie }
}

async function tools(cookie: string): Promise<string[]> {
  const response = await respondViteHubPageSession(nitroApp, new Request(`${origin}/_vitehub/page/tools?page=%2Fguide`, { headers: { cookie } }))
  const body: unknown = await response.json()
  return (Reflect.get(Object(body), "tools") as Array<{ id: string }>).map(tool => tool.id)
}

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
    expect(cookie).toMatch(/^vitehub_site=[a-f0-9]{24}:[a-f0-9]+$/)
    expect(await tools(cookie)).toEqual(["console", "comments"])
    const user = await commentsUser(cookie)
    expect(user).toEqual({ id: "console-ada", name: "Ada", email: "ada@example.com", role: "console,comments-read,comments-write,comments-resolve,comments-delete" })
    expect(commentsRoleAllows(user, "delete")).toBe(true)
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
    expect((await call("site.invites")).value).toEqual({ invites: [expect.objectContaining({ name: "Ana", grants: ["comments-write"], path: "/" })], store: { kind: "kv", driver: "redis" } })
    const { cookie } = await open(String(Reflect.get(Object(value), "url")))
    expect(await tools(cookie)).toEqual(["comments"])
    const user = await commentsUser(cookie)
    expect(user).toMatchObject({ name: "Ana", role: "guest,comments-write" })
    expect([commentsRoleAllows(user, "write"), commentsRoleAllows(user, "delete")]).toEqual([true, false])
    expect((await call("site.invites")).value).toEqual({ invites: [], store: { kind: "kv", driver: "redis" } })
  })

  it("names the store of links and site sessions: the default KV store, or memory on a development server", async ({ onTestFinished }) => {
    expect(await describeConsoleSiteStore(new Request(origin))).toEqual({ kind: "kv", driver: "redis" })
    onTestFinished(() => installConsoleDevelopment("/app", false))
    installConsoleDevelopment("/app", true)
    expect(await describeConsoleSiteStore(new Request(origin))).toEqual({ kind: "memory" })
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
    installConsoleSiteDatabase({ name: "default", load: async () => ({ default: { db } }) })
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

  it("names the Database and table of links and site sessions, and creates no table to do so", () => inD1(async () => {
    expect(await describeConsoleSiteStore(new Request(origin))).toEqual({ kind: "database", name: "default", table: "vitehub_console_site" })
    expect(() => d1.rows()).toThrow(/no such table/)
    expect((await call("site.invites")).value).toEqual({ invites: [], store: { kind: "database", name: "default", table: "vitehub_console_site" } })
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

  it("isolates tickets and sessions for apps with different secrets on one Database", async () => {
    const { cookie } = await inD1(async () => await open(await link("site.link")))
    const pending = await inD1(() => link("site.link"))
    const { sessions } = (await inD1(() => call("site.sessions"))).value as { sessions: { id: string }[] }
    const id = sessions[0]!.id

    await runWithActiveCloudflareEnv({ DB: d1.binding, VITEHUB_SECRET: `${secret}-other-app` }, async () => {
      expect((await call("site.sessions")).value).toEqual({ sessions: [] })
      expect((await call("site.revoke-session", { id })).status).toBe(404)
      expect((await open(pending)).response.status).toBe(401)
    })

    await inD1(async () => {
      expect(await tools(cookie)).toEqual(["console", "comments"])
      expect((await open(pending)).response.status).toBe(303)
    })
  })

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
    installConsoleSiteDatabase({ name: "default", load: async () => ({ default: { db } }) })

    const url = await link("site.link", { path: "/guide" })
    const requests = api.request.mock.calls
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true)
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
    await writeConsoleNitroPlugin({ file, projectRoot: root, sections: ["kv", "databases"], catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token", hiddenSections: ["databases"] }, pageTool: { base: "/" }, siteDatabaseNames: ["default"] })
    const plugin = await readFile(file, "utf8")
    expect(plugin).toContain('installConsoleSiteDatabase({ name: "default", load: async () => (await import("@vite-hub/database/runtime/registry")).databases })')
    expect(plugin).not.toContain("installConsoleDatabase")
    expect(plugin).toContain(' ["kv","site"])')
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe("Site access without Auth picks its store as useDatabase() does", () => {
  async function generated(siteDatabaseNames: string[] | undefined, { sections = ["databases"], siteDatabase, pill = true }: { sections?: ConsoleSectionId[], siteDatabase?: string, pill?: boolean } = {}): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-site-store-"))
    try {
      const file = join(root, "plugin.mjs")
      await writeConsoleNitroPlugin({ file, projectRoot: root, sections, catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token" }, ...(pill ? { pageTool: { base: "/" } } : {}), siteDatabase, siteDatabaseNames })
      return await readFile(file, "utf8")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it("uses the Database named default, else the only Database, and never picks one of several", async () => {
    expect(await generated(["analytics", "default"])).toContain("installConsoleSiteDatabase({ name: \"default\", ")
    expect(await generated(["content"])).toContain("installConsoleSiteDatabase({ name: \"content\", ")
    expect(await generated(["primary", "analytics"])).toContain("installConsoleSiteDatabase({ choices: [\"analytics\",\"primary\"] })")
  })

  it("uses the Database that console.siteAccess.database names", async () => {
    expect(await generated(["primary", "analytics"], { siteDatabase: "primary" })).toContain("installConsoleSiteDatabase({ name: \"primary\", configured: true, ")
    expect(await generated(["analytics", "default"], { siteDatabase: "analytics" })).toContain("installConsoleSiteDatabase({ name: \"analytics\", ")
  })

  it("fails the build when console.siteAccess.database names no Database of the app", async () => {
    await expect(generated(["primary", "analytics"], { siteDatabase: "main" })).rejects.toMatchObject({ code: "VITE_HUB_CONSOLE_SITE_DATABASE_UNKNOWN", message: expect.stringContaining('"analytics", "primary"') })
    await expect(generated([], { siteDatabase: "main" })).rejects.toMatchObject({ code: "VITE_HUB_CONSOLE_SITE_DATABASE_UNKNOWN", message: expect.stringContaining("the app has no Database") })
    expect(await generated(undefined, { siteDatabase: "main" })).not.toContain("installConsoleSiteDatabase(")
  })

  it.each(["primary", "default"])("accepts %s from a standalone Vite Database owner", async (name) => {
    const root = await createProject({
      "package.json": '{"name":"site-access-database","type":"module"}',
      ...(name === "primary" ? {
        "data/server/databases/primary.ts": 'import { defineDatabase } from "vite-hub/database"\nexport default defineDatabase({ name: "primary", schema: {} })\n',
        "data/server/databases/analytics.ts": 'import { defineDatabase } from "vite-hub/database"\nexport default defineDatabase({ name: "analytics", schema: {} })\n',
      } : {}),
    })
    await resolveConfig({
      configFile: false,
      logLevel: "silent",
      plugins: [vitehub({ console: { siteAccess: { database: name } }, host: "node" }), hubDatabase({ projectRoot: "data" })],
      root,
    }, "build", "production")
    expect(await readFile(resolveGeneratedConsolePlugin(root), "utf8")).toContain(`installConsoleSiteDatabase({ name: ${JSON.stringify(name)}, `)
  })

  it("warns at build time when several Databases have no default, unless the app has Auth", async ({ onTestFinished }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    await generated(["primary", "analytics"])
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/VITE_HUB_CONSOLE_SITE_DATABASE_AMBIGUOUS[\s\S]*"analytics", "primary"[\s\S]*siteAccess: \{ database/)
    expect(String(warn.mock.calls[0]?.[0])).toContain("Unless the default KV store is on Redis, Upstash, or the `database` driver")
    await generated(["primary", "analytics"], { sections: ["databases", "auth"] })
    await generated(["primary", "analytics"], { siteDatabase: "analytics" })
    expect(warn).toHaveBeenCalledOnce()
  })

  it("warns at build time when console.siteAccess.database has no effect, and still checks the name", async ({ onTestFinished }) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    onTestFinished(() => warn.mockRestore())
    expect(await generated(["primary", "analytics"], { sections: ["databases", "auth"], siteDatabase: "primary" })).toContain("installConsoleSiteDatabase({ name: \"primary\", ")
    expect(await generated(["primary", "analytics"], { siteDatabase: "primary", pill: false })).not.toContain("installConsoleSiteDatabase(")
    const messages = warn.mock.calls.map(call => String(call[0]))
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatch(/VITE_HUB_CONSOLE_SITE_DATABASE_UNUSED[\s\S]*"primary", but the app has Auth/)
    expect(messages[1]).toMatch(/VITE_HUB_CONSOLE_SITE_DATABASE_UNUSED[\s\S]*Site access is off/)
    await expect(generated(["primary"], { sections: ["databases", "auth"], siteDatabase: "main" })).rejects.toMatchObject({ code: "VITE_HUB_CONSOLE_SITE_DATABASE_UNKNOWN" })
    await expect(generated(["primary"], { siteDatabase: "main", pill: false })).rejects.toMatchObject({ code: "VITE_HUB_CONSOLE_SITE_DATABASE_UNKNOWN" })
    await generated(["primary", "analytics"], { pill: false })
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it("accepts console.siteAccess with a Database name only", () => {
    expect(resolveConsoleOptions({ siteAccess: { database: "primary" } })).toEqual({ siteAccess: { database: "primary" } })
    expect(resolveConsoleOptions({ siteAccess: {} })).toEqual({ siteAccess: {} })
    for (const siteAccess of [false, { database: "" }, { database: 1 }, ["primary"]]) {
      expect(() => resolveConsoleOptions({ siteAccess })).toThrow(expect.objectContaining({ code: "VITE_HUB_B0004", message: expect.stringContaining("console.siteAccess") }))
    }
  })

  it("keeps links in the Database when the app has no KV store", ({ onTestFinished }) => {
    const d1 = createD1()
    onTestFinished(d1.close)
    installConsoleSections("console-site-cookie", ["site"])
    const db = createDrizzleSqliteAdapter({ name: "default", cloudflare: { binding: "DB" } }, defineRelations({}), { missingConnection: "a D1 binding", requireRemoteUrl: true })
    installConsoleSiteDatabase({ name: "default", load: async () => ({ default: { db } }) })
    return runWithActiveCloudflareEnv({ DB: d1.binding }, async () => {
      const { response, cookie } = await open(await link("site.link"))
      expect(response.status).toBe(303)
      expect(d1.rows()).toBe(1)
      expect(await tools(cookie)).toEqual(["console", "comments"])
    })
  })

  it("keeps links in the Database that console.siteAccess.database names, also when the default KV store is on Redis", ({ onTestFinished }) => {
    const d1 = createD1()
    onTestFinished(d1.close)
    const db = createDrizzleSqliteAdapter({ name: "primary", cloudflare: { binding: "DB" } }, defineRelations({}), { missingConnection: "a D1 binding", requireRemoteUrl: true })
    installConsoleSiteDatabase({ name: "primary", configured: true, load: async () => ({ primary: { db } }) })
    return runWithActiveCloudflareEnv({ DB: d1.binding }, async () => {
      const { response, cookie } = await open(await link("site.link"))
      expect(response.status).toBe(303)
      expect(d1.rows()).toBe(1)
      expect(kv.entries.size).toBe(0)
      expect(await tools(cookie)).toEqual(["console", "comments"])
    })
  })

  it.each(["redis", "upstash", "database"])("keeps links in a default KV store on %s and does not open the Database", async (driver) => {
    kv.driver = driver
    const load = vi.fn(async () => ({ default: { db: { $client: { query: vi.fn() } } } }))
    installConsoleSiteDatabase({ name: "default", load })
    const url = await link("site.link")
    expect(kv.entries.size).toBe(1)
    const { response, cookie } = await open(url)
    expect(response.status).toBe(303)
    expect(await tools(cookie)).toEqual(["console", "comments"])
    expect(load).not.toHaveBeenCalled()
  })

  it("consumes a Database-backed ticket from the built Console without the KV peer", async () => {
    await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict"
      import { registerHooks } from "node:module"
      import { DatabaseSync } from "node:sqlite"

      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === "@vite-hub/kv" || specifier.startsWith("@vite-hub/kv/")) throw new Error("KV is not installed: " + specifier)
        return nextResolve(specifier, context)
      } })
      const { installConsoleSections, installConsoleSiteDatabase } = await import("./dist/console/runtime/server/setup.js")
      const { consoleSiteKV } = await import("./dist/console/runtime/server/site-session.js")
      process.env.VITEHUB_SECRET = ${JSON.stringify(secret)}
      const sqlite = new DatabaseSync(":memory:")
      const db = { $client: { async execute({ sql, args }) { return { rows: sqlite.prepare(sql).all(...args) } } } }
      installConsoleSections("console-site-cookie", ["site"])
      installConsoleSiteDatabase({ name: "default", load: async () => ({ default: { db } }) })
      const store = await consoleSiteKV()
      await store.set("ticket", "value", { ttl: 60 })
      assert.deepEqual(await store.getAndDelete("ticket", { type: "text" }), [undefined, "value"])
      assert.deepEqual(await store.getAndDelete("ticket", { type: "text" }), [undefined, null])
    `], { cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 10_000 })
  })

  it("names the Databases when several have no default and no KV store takes a link out once", async () => {
    kv.driver = "cloudflare-kv-binding"
    installConsoleSiteDatabase({ choices: ["analytics", "primary"] })
    const { body } = await call("site.link")
    expect(body).toMatchObject({ code: "CONSOLE_TICKET_STORE_MISSING", message: expect.stringContaining('several Databases and none is named "default": "analytics", "primary"') })
    expect(Reflect.get(Object(body), "message")).toContain("cloudflare-kv-binding driver")
    expect(Reflect.get(Object(body), "message")).toContain('console: { siteAccess: { database: "<name>" } }')
    installConsoleSections("console-site-cookie", ["site"])
    expect((await call("site.link")).body).toMatchObject({ message: expect.stringContaining("The app has no KV store.") })
  })
})

describe("Site access without Auth fails closed", () => {
  it("refuses a link without a KV store that takes a link out once", async () => {
    kv.driver = "cloudflare-kv-binding"
    expect((await call("site.link")).body).toMatchObject({ code: "CONSOLE_TICKET_STORE_MISSING", fix: expect.stringContaining("add a Database") })
    installConsoleSections("console-site-cookie", ["site"])
    expect((await call("site.link")).body).toMatchObject({ code: "CONSOLE_TICKET_STORE_MISSING" })
    expect(kv.entries.size).toBe(0)
  })

  it("names the cause in site.invites and lists no browsers when no store keeps links", async () => {
    kv.driver = "cloudflare-kv-binding"
    const why = expect.stringMatching(/^One-time links need a store that every instance of the app shares\. The app has no Database\. The default KV store uses the cloudflare-kv-binding driver/)
    expect(await describeConsoleSiteStore(new Request(origin))).toEqual({ kind: "none", why })
    expect((await call("site.invites")).value).toEqual({ invites: [], store: { kind: "none", why } })
    expect((await call("site.sessions")).value).toEqual({ sessions: [] })
  })

  it("refuses a link without VITEHUB_SECRET", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    expect((await call("site.link")).body).toMatchObject({ code: "CONSOLE_SITE_SECRET_MISSING", fix: expect.stringContaining("openssl rand -base64 32") })
    expect(kv.entries.size).toBe(0)
  })
})
