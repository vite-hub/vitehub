import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createAuthConsole } from "../../auth/src/console-runtime.ts"
import { consoleEventsFixture } from "../../auth/test/fixtures/console-events.ts"
import { writeConsoleAppModule } from "../src/console/app-module.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { siteActionRoute } from "../src/console/runtime/server/site.ts"
import { assertConsoleAccess, resolveConsoleAccessBuild, resolveConsoleOptions } from "../src/console/vite.ts"
import { installViteHubConsoleOperations } from "./support/console-operations.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"
import { consoleTestKey, signedRpcRequest } from "./support/console-signature.ts"
import { cookieJar, siteActionBrowser } from "./support/site-token.ts"
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

const origin = "http://localhost:5173"
const operator: ConsoleCallerUser = { email: "operator@example.com", id: "console-operator", name: "Operator" }
const key = await consoleTestKey("CONSOLE_TEST")

function signedApp(options: { impersonation?: boolean, sections?: string[] } = {}): void {
  for (const [name, value] of Object.entries(key.env)) vi.stubEnv(name, value)
  installConsoleSections("impersonation-tickets", ["auth"])
  installConsoleAccess({ mode: "token", impersonation: options.impersonation ?? true, authorize: () => ({ sections: options.sections ?? ["auth"] }) })
}

async function operation(name: string, input: Record<string, unknown> = {}, user: ConsoleCallerUser = operator): Promise<Response> {
  return await handleConsoleRpcRequest(await signedRpcRequest({ caller: { user, via: "console" }, input, key: key.key, operation: name, url: `${origin}/_vitehub/rpc` }))
}

async function checked(response: Response): Promise<unknown> {
  const result: unknown = await operationRpcResponseResult(response)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  return Reflect.get(Object(result), "value")
}

function browser(cookie = "") {
  return siteActionBrowser(siteActionRoute, origin, cookie)
}

beforeEach(async () => {
  await installViteHubConsoleOperations()
})

describe("console.impersonation configuration", () => {
  it("accepts only a boolean, needs app Auth, and reaches the generated access policy", async () => {
    expect(resolveConsoleOptions({ impersonation: true })).toMatchObject({ impersonation: true })
    expect(() => resolveConsoleOptions({ impersonation: "yes" })).toThrow("console.impersonation must be true or false")
    expect(() => installConsoleAccess({ mode: "open", impersonation: "yes" as unknown as boolean })).toThrow(expect.objectContaining({ code: "INTERNAL_INVARIANT_FAILED" }))
    expect(() => assertConsoleAccess({ auth: false, impersonation: true }, {})).toThrow("console.impersonation needs app Auth")

    const root = await mkdtemp(join(tmpdir(), "vitehub-console-impersonation-"))
    try {
      expect(resolveConsoleAccessBuild({ auth: false, impersonation: true }, { root })).toMatchObject({ mode: "open", impersonation: true })
      expect(resolveConsoleAccessBuild({}, { root })).toEqual({ mode: "token" })
      const file = join(root, "console.mjs")
      await writeConsoleAppModule({ file, projectRoot: root, sections: [], catalog: { agents: [], content: {} }, blobStores: [], access: { mode: "token", impersonation: true } })
      expect(await readFile(file, "utf8")).toContain('installConsoleAccess({ mode: "token", impersonation: true })')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("impersonation with signed Site access tokens", () => {
  it("refuses the operations and the tokens when console.impersonation is off", async () => {
    signedApp({ impersonation: false })
    for (const name of ["auth.impersonate", "auth.stop-impersonating"]) {
      const response = await operation(name, name === "auth.impersonate" ? { userId: "user-1" } : {})
      expect(response.status).toBe(404)
      expect(await operationRpcResponseResult(response)).toMatchObject({ message: expect.stringContaining("console.impersonation") })
    }
    const visit = await browser()
    const page = await visit.open(await visit.token({ key: key.key, kind: "impersonate", target: { action: "start", userId: "user-1" } }))
    expect(page.status).toBe(404)
    expect(await page.text()).toContain("console.impersonation")
    expect(state.hosts).toEqual([])
  })

  it("lets a read-only Auth grant read users but not start an impersonation", async () => {
    signedApp({ sections: ["auth:read"] })
    const response = await operation("auth.impersonate", { userId: "user-1" })
    expect(response.status).toBe(403)
    expect(await operationRpcResponseResult(response)).toMatchObject({ code: "CONSOLE_ACCESS_DENIED", message: expect.stringContaining("read-only") })
    expect(state.hosts).toEqual([])
  })

  it("checks the operation as the Console person and answers the app path, which the Console signs", async () => {
    const app = await consoleEventsFixture()
    closers.push(() => app.database.sqlite.close())
    state.create = host => createAuthConsole(app.auth, {}, app.store, host as AuthConsoleHostOptions)
    signedApp()
    expect(await checked(await operation("auth.impersonate", { userId: app.member.id }))).toEqual({ path: "/" })
    expect(await checked(await operation("auth.stop-impersonating"))).toEqual({ path: "/" })
    const stranger = await operation("auth.impersonate", { userId: app.member.id }, { email: "stranger@example.com", id: "console-stranger" })
    expect(stranger.status).toBe(403)
    expect(await operationRpcResponseResult(stranger)).toMatchObject({ message: expect.stringContaining("No app user has the email") })
  })

  it("starts and stops impersonation with tokens, restores the admin session, and records both events", async () => {
    const app = await consoleEventsFixture()
    closers.push(() => app.database.sqlite.close())
    state.create = host => createAuthConsole(app.auth, {}, app.store, host as AuthConsoleHostOptions)
    signedApp()

    const described = await operationRpcResponseResult(await operation("auth.describe"))
    expect(state.hosts.at(-1)).toEqual({ actor: { email: "operator@example.com" }, impersonation: true })
    expect(described).toMatchObject({ value: { actions: { impersonate: { enabled: true } }, impersonation: { duration: 3600, active: null } } })

    const visit = await browser(app.operator.cookie)
    const start = await visit.token({ key: key.key, kind: "impersonate", target: { action: "start", userId: app.member.id } })
    const head = await siteActionRoute.fetch(new Request(`${origin}/_vitehub/site?${new URLSearchParams({ token: start, intent: visit.intent })}`, { method: "HEAD", headers: { cookie: visit.cookie } }))
    expect(head.status).toBe(405)
    const started = await visit.open(start)
    expect(started.status).toBe(303)
    expect(started.headers.get("location")).toBe(`${origin}/`)
    expect(state.hosts.at(-1)).toEqual({ impersonation: true })
    const impersonating = cookieJar(visit.cookie, started)
    expect(impersonating).not.toContain("__Host-vitehub-site-state")
    const session = (cookie: string) => app.auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } })
    expect(await session(impersonating)).toMatchObject({ user: { id: app.member.id }, session: { impersonatedBy: app.operator.id } })

    const again = await visit.open(start, impersonating)
    expect(again.status).toBe(401)
    expect(await again.text()).toContain("CONSOLE_SITE_TOKEN_REFUSED")

    const stopVisit = await browser(impersonating)
    const stopped = await stopVisit.open(await stopVisit.token({ key: key.key, kind: "impersonate", target: { action: "stop" } }))
    expect(stopped.status).toBe(303)
    expect(await session(cookieJar(stopVisit.cookie, stopped))).toMatchObject({ user: { id: app.operator.id } })
    for (const type of ["impersonation.started", "impersonation.stopped"] as const)
      expect((await app.store.list({ type })).events, type).toEqual([expect.objectContaining({ actor: `user:${app.operator.id}`, userId: app.member.id })])
  })

  it("binds the token to the app session of the person: another app session, or none, cannot use it", async () => {
    const app = await consoleEventsFixture()
    closers.push(() => app.database.sqlite.close())
    state.create = host => createAuthConsole(app.auth, {}, app.store, host as AuthConsoleHostOptions)
    signedApp()
    const target = { action: "start", userId: app.member.id }

    const signedOut = await browser()
    const refused = await signedOut.open(await signedOut.token({ key: key.key, kind: "impersonate", target }))
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain("Sign in to the app as operator@example.com")

    const ada = await browser(app.member.cookie)
    const other = await ada.open(await ada.token({ key: key.key, kind: "impersonate", target }))
    expect(other.status).toBe(403)
    const page = await other.text()
    expect(page).toContain("CONSOLE_SITE_ACCOUNT_MISMATCH")
    expect(page).toContain("signed in to the app as ada@example.com")
    expect(other.headers.getSetCookie().map(line => line.split("=")[0])).toEqual([`__Host-vitehub-site-state-${ada.intent}`])
    expect((await app.store.list({ type: "impersonation.started" })).events).toEqual([])
  })

  it("stops only the impersonation that the person of the token started in this browser", async () => {
    const app = await consoleEventsFixture()
    closers.push(() => app.database.sqlite.close())
    state.create = host => createAuthConsole(app.auth, {}, app.store, host as AuthConsoleHostOptions)
    signedApp()
    const visit = await browser(app.operator.cookie)
    const impersonating = cookieJar(visit.cookie, await visit.open(await visit.token({ key: key.key, kind: "impersonate", target: { action: "start", userId: app.member.id } })))

    const notImpersonating = await browser(app.operator.cookie)
    const plain = await notImpersonating.open(await notImpersonating.token({ key: key.key, kind: "impersonate", target: { action: "stop" } }))
    expect(plain.status).toBe(409)
    expect(await plain.text()).toContain("does not impersonate")

    const someoneElse = await browser(impersonating)
    const foreign = await someoneElse.open(await someoneElse.token({ key: key.key, kind: "impersonate", target: { action: "stop" }, claims: { sub: "console-ada", name: "Ada", email: "ada@example.com" } }))
    expect(foreign.status).toBe(403)
    expect(await foreign.text()).toContain("CONSOLE_SITE_ACCOUNT_MISMATCH")

    const otherBrowser = await browser(app.operator.cookie)
    const stolen = await otherBrowser.open(await someoneElse.token({ key: key.key, kind: "impersonate", target: { action: "stop" } }))
    expect(stolen.status).toBe(401)
    expect(await stolen.text()).toContain("(SITE_TOKEN_STATE)")

    const session = await app.auth.api.getSession({ headers: new Headers({ cookie: impersonating }), query: { disableCookieCache: true } })
    expect(session).toMatchObject({ user: { id: app.member.id }, session: { impersonatedBy: app.operator.id } })
    expect((await app.store.list({ type: "impersonation.stopped" })).events).toEqual([])
  })
})
