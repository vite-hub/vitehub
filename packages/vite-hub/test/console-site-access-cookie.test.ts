import { DatabaseSync } from "node:sqlite"

import { drizzle } from "drizzle-orm/d1"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime/internal/h3"

import { commentsRoleAllows, defineComments } from "../../comments/src/index.ts"
import { defineCommentsPlugin } from "../../comments/src/runtime/plugin.ts"
import { resolveCommentsIdentity } from "../../comments/src/runtime/session.ts"
import { consoleState } from "../src/console/internal.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDatabase } from "../src/console/runtime/server/database.ts"
import { installConsolePageTool } from "../src/console/runtime/server/page-tool.ts"
import consoleRpcRoute from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
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
  consoleState().database = undefined
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

function createD1(): { binding: object, rows: () => number } {
  const sqlite = new DatabaseSync(":memory:")
  const statement = (query: string, params: (string | number | null)[] = []) => ({
    bind: (...values: (string | number | null)[]) => statement(query, values),
    all: async () => ({ results: sqlite.prepare(query).all(...params), success: true, meta: {} }),
    raw: async () => sqlite.prepare(query).all(...params).map(row => Object.values(row)),
    run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...params) }),
  })
  const rows = () => Number(sqlite.prepare("select count(*) as count from vitehub_kv").get()?.count)
  return { binding: { prepare: (query: string) => statement(query), batch: async () => [] }, rows }
}

describe("Site access without Auth on Cloudflare KV and a D1 Database", () => {
  let d1: ReturnType<typeof createD1>

  beforeEach(() => {
    kv.driver = "cloudflare"
    d1 = createD1()
    installConsoleSections("console-site-cookie", ["site", "kv", "databases"])
    // SAFETY: The stand-in has the D1 methods that Drizzle and the KV `database` driver call.
    installConsoleDatabase("console-site-cookie", { default: { db: drizzle(d1.binding as never), schema: {} } }, ["default"])
  })

  it("keeps one-time links and site sessions in the Database", async () => {
    const url = await link("site.link", { path: "/guide" })
    expect(d1.rows()).toBe(1)
    const { response, cookie } = await open(url)
    expect(response.status).toBe(303)
    expect(await tools(cookie)).toEqual(["console", "comments"])
    expect((await open(url)).response.status).toBe(401)
    const { value } = await call("site.sessions")
    const id = String(Reflect.get(Object((value as { sessions: unknown[] }).sessions[0]), "id"))
    expect((await call("site.revoke-session", { id })).value).toEqual({ revoked: true, removedUser: false })
    expect(await tools(cookie)).toEqual([])
    expect(kv.entries.size).toBe(0)
  })

  it("opens a link once when two browsers open it at the same time", async () => {
    const url = await link("site.link")
    const statuses = (await Promise.all([open(url), open(url)])).map(({ response }) => response.status)
    expect(statuses.sort()).toEqual([303, 401])
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

  it("refuses a link without VITEHUB_SECRET", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    expect((await call("site.link")).body).toMatchObject({ code: "CONSOLE_SITE_SECRET_MISSING", fix: expect.stringContaining("openssl rand -base64 32") })
    expect(kv.entries.size).toBe(0)
  })
})
