import { createContentPreview, defineContentPreviewPlugin } from "../../content/src/preview.ts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installConsoleDevelopment } from "../src/console/runtime/server/development.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleDocuments } from "../src/console/runtime/server/documents.ts"
import consoleRpcRoute from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { consoleTicketLifetime, setConsoleTicketStore } from "../src/console/runtime/server/tickets.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { ConsoleDocumentActions } from "../src/console/runtime/server/documents.ts"
import type { ConsoleTicketStore } from "../src/console/runtime/server/tickets.ts"
import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"

/** Replaces the Auth Console of a request when a test sets it. */
const authServer = vi.hoisted(() => ({ console: undefined as ((request: Request) => unknown) | undefined }))
vi.mock("@vite-hub/auth/internal/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@vite-hub/auth/internal/server")>()
  return {
    ...original,
    getAuthConsoleForRequest: (...args: Parameters<typeof original.getAuthConsoleForRequest>) => authServer.console ? authServer.console(args[0]) : original.getAuthConsoleForRequest(...args),
  }
})

const origin = "http://localhost:5173"
const ada: ConsoleCallerUser = { email: "Ada@Example.com", id: "console-ada", name: "Ada" }
const key = await consoleTestKey("CONSOLE_TICKETS")
const root = "/work/console-tickets"

/** A store like Better Auth's verification table: values by identifier, taken once. */
function mapStore(): ConsoleTicketStore & { entries: Map<string, { value: string, expiresAt: Date }> } {
  const entries = new Map<string, { value: string, expiresAt: Date }>()
  return {
    entries,
    async save(identifier, value, expiresAt) {
      entries.set(identifier, { value, expiresAt })
    },
    async consume(identifier) {
      const entry = entries.get(identifier)
      entries.delete(identifier)
      return entry && entry.expiresAt.getTime() > Date.now() ? entry.value : null
    },
  }
}

/** A Content section whose owner actions sign real preview frame tokens, and record who asked. */
function contentSection(url = "/blog/hello") {
  const preview = createContentPreview({ enabled: true })
  const users: unknown[] = []
  const actions = {
    collections: () => [],
    mediaAccess: () => ({ manage: false, read: true, write: false }),
    get: (input: unknown, context: { user: unknown }) => {
      users.push(context.user)
      return { collection: "posts", id: Reflect.get(Object(input), "id"), url }
    },
    preview: async (input: unknown, context: { user: unknown }) => {
      users.push(context.user)
      const { token } = await preview.sign({ collection: String(Reflect.get(Object(input), "collection")), id: String(Reflect.get(Object(input), "id")) })
      return { parameter: "vitehub-content-preview", token, expiresAt: new Date().toISOString() }
    },
  } as unknown as ConsoleDocumentActions
  installConsoleDocuments(root, { content: { actions: () => actions, load: async () => ({}) } })
  return { preview, users }
}

async function operation(name: string, input: Record<string, unknown>, user: ConsoleCallerUser = ada): Promise<Response> {
  return await handleConsoleRpcRequest(await signedRpcRequest({ caller: { user, via: "console" }, input, key: key.key, operation: name, url: `${origin}/_vitehub/rpc` }))
}

async function link(): Promise<string> {
  const result: unknown = await operationRpcResponseResult(await operation("documents.preview", { collection: "posts", id: "hello", section: "content" }))
  const url = Reflect.get(Object(Reflect.get(Object(result), "value")), "url")
  if (String(url) !== url) throw new Error(`No link: ${JSON.stringify(result)}`)
  return url
}

function open(url: string): Promise<Response> {
  return consoleRpcRoute.fetch(new Request(url))
}

beforeEach(() => {
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
  vi.stubEnv("VITEHUB_CONTENT_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
  installConsoleSections(root, ["content"])
  installConsoleAccess({ mode: "token", authorize: () => true })
})

afterEach(() => {
  authServer.console = undefined
  setConsoleTicketStore(undefined)
  installConsoleDevelopment(root, false)
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.tickets"))
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("one-time links", () => {
  it("opens the draft of the document: the form posts a frame token that the Content preview plugin accepts", async () => {
    const store = mapStore()
    setConsoleTicketStore(store)
    const { preview, users } = contentSection()
    const url = await link()
    // The store holds the SHA-256 of the ticket, never the ticket.
    const ticket = new URL(url).searchParams.get("ticket")!
    expect([...store.entries.keys()]).toEqual([expect.stringMatching(/^vitehub-console-ticket:[\w-]{43}$/)])
    expect(JSON.stringify([...store.entries])).not.toContain(ticket)

    const page = await open(url)
    expect(page.status).toBe(200)
    expect(page.headers.get("cache-control")).toBe("no-store")
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[\w+/=]+'; form-action 'self'/)
    const html = await page.text()
    const action = /<form method="post" action="([^"]+)">/.exec(html)?.[1]?.replaceAll("&#38;", "&")
    const value = /name="vitehub-content-preview" value="([^"]+)"/.exec(html)?.[1]?.replaceAll("&#34;", "\"")
    expect(action).toBe(`${origin}/blog/hello?vitehub-content-preview=`)
    // The owner actions ran as the signed person, both when the link was made and when it opened.
    expect(users).toEqual([expect.objectContaining({ id: "console-ada" }), expect.objectContaining({ id: "console-ada" })])

    // The page of the app runs in the frame scope of that one document, as the Content preview plugin renders it.
    const nitroApp: { fetch: (request: Request) => Promise<Response>, hooks: { hook(): void } } = {
      fetch: async () => Response.json(preview.frame() ?? null),
      hooks: { hook() {} },
    }
    defineContentPreviewPlugin({ preview })(nitroApp)
    const rendered = await nitroApp.fetch(new Request(action!, {
      body: new URLSearchParams({ "vitehub-content-preview": value! }),
      headers: { "content-type": "application/x-www-form-urlencoded", host: "localhost:5173", origin, "sec-fetch-site": "same-origin" },
      method: "POST",
    }))
    expect(await rendered.json()).toEqual({ collection: "posts", id: "hello" })
  })

  it("works once", async () => {
    setConsoleTicketStore(mapStore())
    contentSection()
    const url = await link()
    expect((await open(url)).status).toBe(200)
    const again = await open(url)
    expect(again.status).toBe(401)
    expect(await again.text()).toContain("CONSOLE_TICKET_INVALID")
  })

  it("expires after its lifetime", async () => {
    setConsoleTicketStore(mapStore())
    contentSection()
    vi.useFakeTimers({ now: Date.parse("2026-11-11T10:00:00.000Z"), toFake: ["Date"] })
    const url = await link()
    vi.setSystemTime(Date.parse("2026-11-11T10:00:00.000Z") + (consoleTicketLifetime + 1) * 1000)
    const expired = await open(url)
    expect(expired.status).toBe(401)
    expect(await expired.text()).toContain("CONSOLE_TICKET_INVALID")
  })

  it("is refused when it is changed, malformed, or opened on another app", async () => {
    setConsoleTicketStore(mapStore())
    contentSection()
    const url = new URL(await link())
    const ticket = url.searchParams.get("ticket")!
    const changed = new URL(url)
    changed.searchParams.set("ticket", `${ticket.slice(0, -1)}${ticket.endsWith("A") ? "B" : "A"}`)
    for (const candidate of [changed.href, `${origin}/_vitehub/rpc?ticket=nope`]) {
      const response = await open(candidate)
      expect(response.status, candidate).toBe(401)
      expect(await response.text()).toContain("CONSOLE_TICKET_INVALID")
    }
    // The unchanged ticket on another origin is refused, and it is used up.
    const elsewhere = await open(url.href.replace(origin, "http://127.0.0.1:5173"))
    expect(elsewhere.status).toBe(403)
    expect(await elsewhere.text()).toContain("CONSOLE_TICKET_MISMATCH")
    expect((await open(url.href)).status).toBe(401)

    const mounted = new URL(await link())
    const portal = await open(`${origin}/portal/_vitehub/rpc${mounted.search}`)
    expect(portal.status).toBe(403)
  })

  it("refuses a document whose page is on another site", async () => {
    setConsoleTicketStore(mapStore())
    contentSection("https://elsewhere.example/blog/hello")
    const response = await operation("documents.preview", { collection: "posts", id: "hello", section: "content" })
    expect(response.status).toBe(409)
    expect(await operationRpcResponseResult(response)).toMatchObject({ message: "The page URL of the document is not on this app." })
  })

  it("fails closed in production without a shared store, and keeps tickets in memory on a development server", async () => {
    contentSection()
    const missing = await operation("documents.preview", { collection: "posts", id: "hello", section: "content" })
    expect(missing.status).toBe(500)
    expect(await operationRpcResponseResult(missing)).toMatchObject({ code: "CONSOLE_TICKET_STORE_MISSING", fix: expect.stringContaining("authDatabase()") })
    const page = await open(`${origin}/_vitehub/rpc?ticket=vt1_${"A".repeat(43)}`)
    expect(page.status).toBe(500)
    expect(await page.text()).toContain("CONSOLE_TICKET_STORE_MISSING")

    installConsoleDevelopment(root, true)
    const url = await link()
    expect((await open(url)).status).toBe(200)
    expect((await open(url)).status).toBe(401)
  })

  it("fails closed in production when Auth has only the memory database that it adds for one process", async () => {
    const { defineAuth } = await import("@vite-hub/auth")
    const { createAuthForRequest } = await import("@vite-hub/auth/internal/server")
    const { createAuthConsole } = await import("@vite-hub/auth/console-runtime")
    const definition = defineAuth({ emailAndPassword: { enabled: true }, runtime: { secret: "console-tickets-memory-secret-abcdefghijklmnopqrstuvwxyz", baseURL: origin } })
    authServer.console = request => createAuthConsole(createAuthForRequest(definition, request))
    installConsoleSections(root, ["content", "auth"])
    contentSection()
    const missing = await operation("documents.preview", { collection: "posts", id: "hello", section: "content" })
    expect(missing.status).toBe(500)
    expect(await operationRpcResponseResult(missing)).toMatchObject({ code: "CONSOLE_TICKET_STORE_MISSING" })

    // A development server keeps them in this process, and each one still works once.
    installConsoleDevelopment(root, true)
    const url = await link()
    expect((await open(url)).status).toBe(200)
    expect((await open(url)).status).toBe(401)
  })

  it("is not a way in without a signature: a GET without a ticket gets the signed-call refusal", async () => {
    const response = await consoleRpcRoute.fetch(new Request(`${origin}/_vitehub/rpc`))
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: "CONSOLE_SIGNATURE_INVALID" })
  })
})
