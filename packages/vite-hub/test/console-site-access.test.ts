import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readViteHubPagePass, registerViteHubPagePassReader, registerViteHubPageTool, respondViteHubPageSession } from "@vite-hub/internal/runtime/page-tools"

import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { consolePageToolAllowed } from "../src/console/runtime/server/page-tool.ts"
import consoleRpcRoute from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { readConsolePagePass } from "../src/console/runtime/server/site-access.ts"
import { setConsoleTicketStore } from "../src/console/runtime/server/tickets.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleRecordStore } from "../src/console/runtime/server/tickets.ts"
import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"

const origin = "https://app.example.com"
const ada: ConsoleCallerUser = { email: "Ada@Example.com", id: "console-ada", name: "Ada" }
const key = await consoleTestKey("CONSOLE_SITE")
const root = "/work/console-site-access"
const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

/** A store like Better Auth's verification table, with the record methods of page passes. */
function mapStore(): ConsoleRecordStore & { entries: Map<string, { value: string, expiresAt: Date }> } {
  const entries = new Map<string, { value: string, expiresAt: Date }>()
  const live = (identifier: string) => {
    const entry = entries.get(identifier)
    return entry && entry.expiresAt.getTime() > Date.now() ? entry : undefined
  }
  return {
    entries,
    async save(identifier, value, expiresAt) {
      entries.set(identifier, { value, expiresAt })
    },
    async consume(identifier) {
      const entry = live(identifier)
      entries.delete(identifier)
      return entry?.value ?? null
    },
    async read(identifier) {
      return live(identifier)?.value ?? null
    },
    async list(prefix) {
      return [...entries.keys()].filter(identifier => identifier.startsWith(prefix) && live(identifier)).map(identifier => ({ identifier, ...live(identifier)! }))
    },
    async update(identifier, value, expiresAt) {
      if (entries.has(identifier)) entries.set(identifier, { value, expiresAt })
    },
    async remove(identifier) {
      entries.delete(identifier)
    },
  }
}

async function call(name: string, input: Record<string, unknown> = {}): Promise<{ status: number, value: unknown, body: unknown }> {
  const response = await handleConsoleRpcRequest(await signedRpcRequest({ caller: { user: ada, via: "console" }, input, key: key.key, operation: name, url: `${origin}/_vitehub/rpc` }))
  const body: unknown = await operationRpcResponseResult(response)
  return { status: response.status, value: Reflect.get(Object(body), "value"), body }
}

async function link(name: string, input: Record<string, unknown> = {}): Promise<string> {
  const { value, body } = await call(name, input)
  const url: unknown = Reflect.get(Object(value), "url")
  if (String(url) !== url) throw new Error(`No link: ${JSON.stringify(body)}`)
  return url
}

/** Opens a one-time link in a browser, and returns the redirect and the pass cookie it set. */
async function open(url: string, userAgent = chrome, cookie?: string): Promise<{ response: Response, pass?: string }> {
  const response = await consoleRpcRoute.fetch(new Request(url, { headers: { "user-agent": userAgent, ...(cookie ? { cookie } : {}) } }))
  const pass = response.headers.getSetCookie().find(value => value.startsWith("vitehub-pass="))?.split(";")[0]
  return { response, ...(pass ? { pass } : {}) }
}

function page(cookie: string | undefined, path = "/"): Request {
  return new Request(`${origin}${path}`, { headers: cookie ? { cookie } : {} })
}

const pageApp = {}

beforeEach(() => {
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
  installConsoleSections(root, ["site"])
  installConsoleAccess({ mode: "token" })
  registerViteHubPageTool(pageApp, {
    id: "comments",
    label: "Comments",
    icon: "i-lucide-message-square-text",
    script: "/comments.js",
    grants: [{ id: "comments.read", label: "Read comments" }, { id: "comments.write", label: "Write comments" }],
    allowed: async ({ request }) => (await readViteHubPagePass(request))?.grants.includes("comments.read") === true,
  })
  registerViteHubPagePassReader(readConsolePagePass)
})

afterEach(() => {
  setConsoleTicketStore(undefined)
  registerViteHubPagePassReader(undefined)
  installConsoleDevelopment(root, false)
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.tickets"))
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("member passes", () => {
  it("gives the browser that opens the link a pass as the Console person, with the Console and every page tool", async () => {
    const store = mapStore()
    setConsoleTicketStore(store)
    const { response, pass } = await open(await link("site.link", { path: "/runs/42" }))
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(`${origin}/runs/42`)
    const cookies = response.headers.getSetCookie()
    expect(cookies).toEqual(expect.arrayContaining([
      expect.stringMatching(/^vitehub-pass=vp1_[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure$/),
      "vitehub-tools=1; Path=/; Max-Age=7776000; SameSite=Lax",
    ]))
    // The store keeps the SHA-256 of the pass, never the pass.
    expect(JSON.stringify([...store.entries])).not.toContain(pass!.split("=")[1])

    expect(await readViteHubPagePass(page(pass))).toEqual({
      id: expect.any(String),
      kind: "member",
      person: { id: "console-ada", name: "Ada", email: "ada@example.com" },
      grants: ["console", "comments.read", "comments.write"],
    })
    expect(await readViteHubPagePass(page(undefined))).toBeUndefined()
    expect(await readViteHubPagePass(page("vitehub-pass=vp1_forged"))).toBeUndefined()
  })

  it("shows the Console link of the pill to a member pass, never to a guest pass or a visitor", async () => {
    setConsoleTicketStore(mapStore())
    const member = (await open(await link("site.link"))).pass
    const guest = (await open(await link("site.invite", { name: "Ana", grants: ["comments.write"] }))).pass
    expect(await consolePageToolAllowed(page(member))).toBe(true)
    expect(await consolePageToolAllowed(page(guest))).toBe(false)
    expect(await consolePageToolAllowed(page(undefined))).toBe(false)
  })

  it("keeps the page tools hint for as long as the pass, and the tools of the pass", async () => {
    setConsoleTicketStore(mapStore())
    const { pass } = await open(await link("site.link"))
    const session = await respondViteHubPageSession(pageApp, new Request(`${origin}/_vitehub/page/session`, { headers: { cookie: pass! } }))
    expect(await session.json()).toMatchObject({ tools: [{ id: "comments" }] })
    expect(session.headers.get("set-cookie")).toBe("vitehub-tools=1; Path=/; Max-Age=7776000; SameSite=Lax")
  })

  it("lasts 10 minutes for a phone", async () => {
    setConsoleTicketStore(mapStore())
    const { value } = await call("site.link", { qr: true })
    const left = Date.parse(String(Reflect.get(Object(value), "expiresAt"))) - Date.now()
    expect(left).toBeGreaterThan(9 * 60_000)
    expect(left).toBeLessThanOrEqual(10 * 60_000)
  })

  it("replaces the pass that the browser already holds, so one browser is one entry", async () => {
    setConsoleTicketStore(mapStore())
    const first = (await open(await link("site.link"))).pass!
    const second = (await open(await link("site.link"), chrome, first)).pass!
    expect(await readViteHubPagePass(page(first))).toBeUndefined()
    expect(await readViteHubPagePass(page(second))).toMatchObject({ kind: "member" })
    expect((await call("site.passes")).value).toMatchObject({ passes: [{ device: "Chrome on macOS" }] })
  })
})

describe("the list of browsers", () => {
  it("lists every browser without its secret, and a revoked browser loses its pass", async () => {
    const store = mapStore()
    setConsoleTicketStore(store)
    const laptop = (await open(await link("site.link"))).pass!
    const phone = (await open(await link("site.link", { qr: true }), iphone)).pass!
    const { value } = await call("site.passes")
    const passes = Reflect.get(Object(value), "passes") as { id: string, device: string }[]
    expect(passes.map(pass => pass.device).sort()).toEqual(["Chrome on macOS", "Safari on iPhone"])
    expect(JSON.stringify(value)).not.toContain(laptop.split("=")[1])

    const phoneId = passes.find(pass => pass.device === "Safari on iPhone")!.id
    expect((await call("site.revoke-pass", { id: phoneId })).status).toBe(200)
    expect(await readViteHubPagePass(page(phone))).toBeUndefined()
    expect(await readViteHubPagePass(page(laptop))).toMatchObject({ kind: "member" })
    expect((await call("site.revoke-pass", { id: phoneId })).status).toBe(404)
  })

  it("ends every pass of a Console key when the app no longer has the key, as unlinking does", async () => {
    setConsoleTicketStore(mapStore())
    const { pass } = await open(await link("site.link"))
    for (const name of Object.keys(key.env)) vi.stubEnv(name, "")
    expect(await readViteHubPagePass(page(pass))).toBeUndefined()
  })

  it("lasts 90 days after its last use", async () => {
    setConsoleTicketStore(mapStore())
    const start = Date.parse("2026-11-12T10:00:00.000Z")
    vi.useFakeTimers({ now: start, toFake: ["Date"] })
    const { pass } = await open(await link("site.link"))
    const day = 24 * 60 * 60 * 1000
    vi.setSystemTime(start + 80 * day)
    expect(await readViteHubPagePass(page(pass))).toMatchObject({ kind: "member" })
    // Used on day 80, so it still works on day 160.
    vi.setSystemTime(start + 160 * day)
    expect(await readViteHubPagePass(page(pass))).toMatchObject({ kind: "member" })
    vi.setSystemTime(start + 251 * day)
    expect(await readViteHubPagePass(page(pass))).toBeUndefined()
  })
})

describe("guest invites", () => {
  it("gives one browser a guest pass with the name and the grants, and works once", async () => {
    setConsoleTicketStore(mapStore())
    const url = await link("site.invite", { name: "Ana from design", grants: ["comments.read", "comments.write"], expiresInDays: 30 })
    expect((await call("site.invites")).value).toMatchObject({ invites: [{ name: "Ana from design", grants: ["comments.read", "comments.write"], path: "/" }] })

    const { response, pass } = await open(url)
    expect(response.status).toBe(303)
    expect(await readViteHubPagePass(page(pass))).toEqual({
      id: expect.any(String),
      kind: "guest",
      person: { id: expect.stringMatching(/^pass:/), name: "Ana from design" },
      grants: ["comments.read", "comments.write"],
    })
    expect((await call("site.invites")).value).toEqual({ invites: [] })
    const again = await open(url)
    expect(again.response.status).toBe(401)
    expect(again.pass).toBeUndefined()
  })

  it("never gives a guest the Console, or a grant that no page tool declares", async () => {
    setConsoleTicketStore(mapStore())
    for (const grants of [["console"], ["comments.read", "database.write"], []]) {
      const { status } = await call("site.invite", { name: "Ana", grants })
      expect(status, grants.join()).toBe(400)
    }
    expect((await call("site.invite", { name: "  ", grants: ["comments.read"] })).status).toBe(400)
  })

  it("stops the link of a revoked invite", async () => {
    setConsoleTicketStore(mapStore())
    const { value } = await call("site.invite", { name: "Ana", grants: ["comments.read"] })
    const id = String(Reflect.get(Object(Reflect.get(Object(value), "invite")), "id"))
    expect((await call("site.revoke-invite", { id })).status).toBe(200)
    expect((await open(String(Reflect.get(Object(value), "url")))).response.status).toBe(401)
  })

  it("lasts the days the member picked", async () => {
    setConsoleTicketStore(mapStore())
    const start = Date.parse("2026-11-12T10:00:00.000Z")
    vi.useFakeTimers({ now: start, toFake: ["Date"] })
    const url = await link("site.invite", { name: "Ana", grants: ["comments.read"], expiresInDays: 1 })
    vi.setSystemTime(start + 25 * 60 * 60 * 1000)
    expect((await open(url)).response.status).toBe(401)
  })
})

describe("the grants", () => {
  it("lists the Console for members, then the grants of the page tools", async () => {
    expect((await call("site.grants")).value).toEqual({ grants: [
      expect.objectContaining({ id: "console", membersOnly: true }),
      { id: "comments.read", label: "Read comments" },
      { id: "comments.write", label: "Write comments" },
    ] })
  })
})
