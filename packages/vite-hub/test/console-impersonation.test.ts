import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAuthConsole } from "../../auth/src/console-runtime.ts"
import { consoleEventsFixture } from "../../auth/test/fixtures/console-events.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import consoleRpcRoute from "../src/console/runtime/server/rpc.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { assertConsoleAccess, resolveConsoleAccessBuild, resolveConsoleOptions } from "../src/console/vite.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

import type { AuthConsoleHostOptions } from "../../auth/src/console-types.ts"
import type { ConsoleCallerUser } from "@vite-hub/internal/console-signature"

const state = vi.hoisted(() => ({ create: undefined as undefined | ((host: unknown) => unknown), hosts: [] as unknown[] }))
vi.mock("@vite-hub/auth/server", async importOriginal => ({
  ...(await importOriginal<typeof import("@vite-hub/auth/server")>()),
  getAuthConsoleForRequest: (_request: Request, _event: unknown, host: unknown) => {
    state.hosts.push(host)
    return state.create?.(host)
  },
}))
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  state.create = undefined
  state.hosts = []
  vi.unstubAllEnvs()
})

/** Merge the cookies that a response sets into a Cookie header, as a browser does. */
function jar(cookie: string, response: Response): string {
  const values = new Map(cookie.split("; ").filter(Boolean).map(pair => [pair.slice(0, pair.indexOf("=")), pair] as const))
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0]!
    const name = pair.slice(0, pair.indexOf("="))
    if (/max-age=0/i.test(header) || pair.endsWith("=")) values.delete(name)
    else values.set(name, pair)
  }
  return [...values.values()].join("; ")
}

const origin = "http://localhost:5173"
const operator: ConsoleCallerUser = { email: "operator@example.com", id: "console-operator", name: "Operator" }
const key = await consoleTestKey("CONSOLE_TEST")

/** Take signed calls only, as an app with `console: true` does, with `console.impersonation`. */
function signedApp(options: { impersonation?: boolean, sections?: string[] } = {}): void {
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
  installConsoleSections("impersonation-tickets", ["auth"])
  installConsoleAccess({ mode: "token", impersonation: options.impersonation ?? true, authorize: () => ({ sections: options.sections ?? ["auth"] }) })
}

/** One operation, signed by the Console for `user`, as the Console server forwards it. */
async function operation(name: string, input: Record<string, unknown> = {}, user: ConsoleCallerUser = operator): Promise<Response> {
  return await handleConsoleRpcRequest(await signedRpcRequest({ caller: { user, via: "console" }, input, key: key.key, operation: name, url: `${origin}/_vitehub/rpc` }))
}

/** The link of a successful ticket operation. */
async function link(response: Response): Promise<string> {
  const result: unknown = await operationRpcResponseResult(response)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { url: expect.stringMatching(/^http:\/\/localhost:5173\/_vitehub\/rpc\?ticket=vt1_[\w-]{43}$/) } })
  return String(Reflect.get(Object(Reflect.get(Object(result), "value")), "url"))
}

/** The browser opens the link with its app cookies. */
async function open(url: string, cookie = ""): Promise<Response> {
  return await consoleRpcRoute.fetch(new Request(url, { headers: cookie ? { cookie } : {} }))
}

describe("console.impersonation configuration", () => {
  it("accepts only a boolean, needs app Auth, and reaches the generated access policy", async () => {
    expect(resolveConsoleOptions({ impersonation: true })).toMatchObject({ impersonation: true })
    expect(() => resolveConsoleOptions({ impersonation: "yes" })).toThrow("console.impersonation must be true or false")
    expect(() => installConsoleAccess({ mode: "open", impersonation: "yes" as unknown as boolean })).toThrow("console.impersonation must be true or false")
    expect(() => assertConsoleAccess({ auth: false, impersonation: true }, {})).toThrow("console.impersonation needs app Auth")

    const root = await mkdtemp(join(tmpdir(), "vitehub-console-impersonation-"))
    try {
      expect(resolveConsoleAccessBuild({ auth: false, impersonation: true }, { root })).toMatchObject({ mode: "open", impersonation: true })
      expect(resolveConsoleAccessBuild({}, { root })).toEqual({ mode: "token" })
      const file = join(root, "console.mjs")
      await writeConsoleNitroPlugin({ file, projectRoot: root, sections: [], catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token", impersonation: true } })
      expect(await readFile(file, "utf8")).toContain('installConsoleAccess({ mode: "token", impersonation: true })')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("impersonation with one-time links", () => {
  it("refuses the links when console.impersonation is off", async () => {
    signedApp({ impersonation: false })
    for (const name of ["auth.impersonate", "auth.stop-impersonating"]) {
      const response = await operation(name, name === "auth.impersonate" ? { userId: "user-1" } : {})
      expect(response.status).toBe(404)
      expect(await operationRpcResponseResult(response)).toMatchObject({ message: expect.stringContaining("console.impersonation") })
    }
    // The operation refuses before it opens the Auth Console.
    expect(state.hosts).toEqual([])
  })

  it("lets a read-only Auth grant read users but not make an impersonation link", async () => {
    signedApp({ sections: ["auth:read"] })
    const response = await operation("auth.impersonate", { userId: "user-1" })
    expect(response.status).toBe(403)
    expect(await operationRpcResponseResult(response)).toMatchObject({ code: "CONSOLE_ACCESS_DENIED", message: expect.stringContaining("read-only") })
    expect(state.hosts).toEqual([])
  })

  it("starts and stops impersonation with links, restores the admin session, and records both events", async () => {
    const app = await consoleEventsFixture()
    closers.push(() => app.database.sqlite.close())
    state.create = host => createAuthConsole(app.auth, {}, app.store, host as AuthConsoleHostOptions)
    signedApp()

    // The Console person acts as the app account with the same email.
    const described = await operationRpcResponseResult(await operation("auth.describe"))
    expect(state.hosts.at(-1)).toEqual({ actor: { email: "operator@example.com" }, impersonation: true })
    expect(described).toMatchObject({ value: { actions: { impersonate: { enabled: true } }, impersonation: { duration: 3600, active: null } } })

    const start = await link(await operation("auth.impersonate", { userId: app.member.id }))
    // The browser of the operator opens it: the app sets the impersonation cookies and opens its home page.
    const started = await open(start, app.operator.cookie)
    expect(started.status).toBe(303)
    expect(started.headers.get("location")).toBe(`${origin}/`)
    const impersonating = jar(app.operator.cookie, started)
    const session = (cookie: string) => app.auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } })
    expect(await session(impersonating)).toMatchObject({ user: { id: app.member.id }, session: { impersonatedBy: app.operator.id } })

    // A link works once.
    const again = await open(start, app.operator.cookie)
    expect(again.status).toBe(401)
    expect(await again.text()).toContain("CONSOLE_TICKET_INVALID")

    const stop = await link(await operation("auth.stop-impersonating"))
    const stopped = await open(stop, impersonating)
    expect(stopped.status).toBe(303)
    expect(await session(jar(impersonating, stopped))).toMatchObject({ user: { id: app.operator.id } })
    for (const type of ["impersonation.started", "impersonation.stopped"] as const)
      expect((await app.store.list({ type })).events, type).toEqual([expect.objectContaining({ actor: `user:${app.operator.id}`, userId: app.member.id })])
  })

  it("binds the link to the person: another app session, or none, cannot use it", async () => {
    const app = await consoleEventsFixture()
    closers.push(() => app.database.sqlite.close())
    state.create = host => createAuthConsole(app.auth, {}, app.store, host as AuthConsoleHostOptions)
    signedApp()

    const signedOut = await open(await link(await operation("auth.impersonate", { userId: app.member.id })))
    expect(signedOut.status).toBe(403)
    expect(await signedOut.text()).toContain("Sign in to the app as operator@example.com")

    // Ada is signed in to the app, but the link was made for the operator.
    const other = await open(await link(await operation("auth.impersonate", { userId: app.member.id })), app.member.cookie)
    expect(other.status).toBe(403)
    const page = await other.text()
    expect(page).toContain("CONSOLE_TICKET_MISMATCH")
    expect(page).toContain("signed in to the app as ada@example.com")
    expect(other.headers.get("set-cookie")).toBeNull()
    expect((await app.store.list({ type: "impersonation.started" })).events).toEqual([])

    // A Console person without an app account cannot make a link.
    const stranger = await operation("auth.impersonate", { userId: app.member.id }, { email: "stranger@example.com", id: "console-stranger" })
    expect(stranger.status).toBe(403)
    expect(await operationRpcResponseResult(stranger)).toMatchObject({ message: expect.stringContaining("No app user has the email") })
  })
})
