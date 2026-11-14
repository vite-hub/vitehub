import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"
import { installRequestStandardContext } from "@vite-hub/runtime/internal/h3"

import { commentsRoleAllows, defineComments } from "../../comments/src/index.ts"
import { defineCommentsPlugin } from "../../comments/src/runtime/plugin.ts"
import { resolveCommentsIdentity } from "../../comments/src/runtime/session.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
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
      async keys(base: string) {
        // Redis lists keys with `:`; some drivers use `/`.
        return [undefined, [...entries.keys()].filter(key => key.startsWith(base) && live(key) !== null).map(key => key.replaceAll(":", "/"))] as const
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
  const response = await respondViteHubPageSession(nitroApp, new Request(`${origin}/_vitehub/page/session?page=%2Fguide`, { headers: { cookie } }))
  const body: unknown = await response.json()
  return (Reflect.get(Object(body), "tools") as Array<{ id: string }>).map(tool => tool.id)
}

/** The person that Comments resolves for this browser. */
async function commentsUser(cookie: string): Promise<CommentsUser | null> {
  const request = new Request(`${origin}/api/_vitehub/comments/session`, { headers: { cookie } })
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
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("Site access without Auth", () => {
  it("signs a member in with a sealed cookie that shows the Console link and Comments", async () => {
    expect(await tools("")).toEqual([])
    const url = await link("site.link", { path: "/guide" })
    const { response, cookie } = await open(url)
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${origin}/guide`)
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

describe("Site access without Auth fails closed", () => {
  it("refuses a link without a KV store that takes a link out once", async () => {
    kv.driver = "cloudflare-kv-binding"
    expect((await call("site.link")).body).toMatchObject({ code: "CONSOLE_TICKET_STORE_MISSING", fix: expect.stringContaining("Redis, Upstash, or the `database` driver") })
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
