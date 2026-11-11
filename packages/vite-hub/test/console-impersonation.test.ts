import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { runInNewContext } from "node:vm"
import { Window, type HTMLButtonElement } from "happy-dom"
import { defineAuth, type AuthSessionRefresh } from "@vite-hub/auth"
import { createAuthAccessHandler, createAuthForRequest, requireAuthAccessRoutes, withAuthorization } from "@vite-hub/auth/server"
import { adminPlugin } from "../../auth/test/fixtures/admin-plugin.ts"
import { H3 } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createAuthConsole } from "../../auth/src/console-runtime.ts"
import { consoleEventsFixture } from "../../auth/test/fixtures/console-events.ts"
import { createConsoleAppAuthAccess, createConsoleAppAuthPages } from "../src/console/auth-pages.ts"
import { writeConsoleNitroPlugin } from "../src/console/plugin.ts"
import { installConsoleAccess } from "../src/console/runtime/server/access.ts"
import authManage from "../src/console/runtime/server/auth-manage.ts"
import { installConsoleSections } from "../src/console/runtime/server/sections.ts"
import { assertConsoleAccess, resolveConsoleAccessBuild, resolveConsoleOptions } from "../src/console/vite.ts"
import { requestEvent } from "./console-event.ts"
import { handleConsoleRpcRequest } from "./support/console-rpc.ts"

const state = vi.hoisted(() => ({ inspect: undefined as unknown, host: undefined as unknown }))
vi.mock("@vite-hub/auth/server", async importOriginal => ({
  ...(await importOriginal<typeof import("@vite-hub/auth/server")>()),
  getAuthConsoleForRequest: (_request: Request, _event: unknown, host: unknown) => {
    state.host = host
    return state.inspect
  },
}))
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0)) close()
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"))
  state.inspect = undefined
  state.host = undefined
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

function manage(body: unknown, cookie = "") {
  return authManage.fetch(new Request("http://localhost:5173/_vitehub/auth/manage", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-vitehub-console": "1", origin: "http://localhost:5173", cookie },
  }))
}

/** One `auth.*` operation through the Console RPC, with the cookies of the browser. */
async function operation(name: string, input: Record<string, unknown> = {}, cookie = "") {
  return await handleConsoleRpcRequest(new Request("http://localhost:5173/_vitehub/rpc/__call", {
    method: "POST",
    body: JSON.stringify({ operation: name, input }),
    headers: { "content-type": "application/json", "x-vitehub-console": "1", origin: "http://localhost:5173", cookie },
  }))
}

describe("console.impersonation configuration", () => {
  it("accepts only a boolean, needs app Auth, and reaches the generated access policy", async () => {
    expect(resolveConsoleOptions({ auth: "app", impersonation: true })).toMatchObject({ impersonation: true })
    expect(() => resolveConsoleOptions({ auth: "app", impersonation: "yes" })).toThrow("console.impersonation must be true or false")
    expect(() => installConsoleAccess({ mode: "open", impersonation: "yes" as unknown as boolean })).toThrow("console.impersonation must be true or false")
    expect(() => assertConsoleAccess({ auth: false, impersonation: true }, {})).toThrow("console.impersonation needs app Auth")

    const root = await mkdtemp(join(tmpdir(), "vitehub-console-impersonation-"))
    try {
      expect(resolveConsoleAccessBuild({ auth: false, impersonation: true }, { root })).toMatchObject({ mode: "open", impersonation: true })
      expect(resolveConsoleAccessBuild({ auth: "app" }, { root })).not.toHaveProperty("impersonation")
      const routes = [{ authorize: true, index: 0, route: "/_vitehub/**" }]
      const file = join(root, "console.mjs")
      await writeConsoleNitroPlugin({ file, projectRoot: root, sections: [], catalog: { agents: [], content: {} }, blobStores: [], access: { check: { appRoutes: routes }, mode: "auth", impersonation: true } })
      const generated = await readFile(file, "utf8")
      expect(generated).toContain("requireSession: vitehubRequireSession, impersonation: true })")
      expect(generated).toMatch(/installConsoleAccess\(\{ mode: "auth", .*impersonation: true \}\)/)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe("Auth Console impersonation route", () => {
  it("rejects start and stop when console.impersonation is off", async () => {
    const inspect = { describe: vi.fn(), execute: vi.fn(), stopImpersonating: vi.fn() }
    state.inspect = inspect
    installConsoleSections("impersonation-off", ["auth"])
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["auth"] }) })
    for (const body of [{ action: "impersonate", userId: "user-1" }, { action: "stopImpersonating" }]) {
      const response = await manage(body)
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ message: expect.stringContaining("console.impersonation") })
    }
    // The route refuses before it opens the Auth Console.
    expect(state.host).toBeUndefined()
    expect(inspect.execute).not.toHaveBeenCalled()
    expect(inspect.stopImpersonating).not.toHaveBeenCalled()
  })

  it("lets a read-only Auth grant list users but not change them", async () => {
    const inspect = { users: vi.fn(async () => [undefined, { items: [], total: 0, offset: 0, limit: 25 }]), execute: vi.fn() }
    state.inspect = inspect
    installConsoleSections("impersonation-read-only", ["auth"])
    installConsoleAccess({ mode: "open", impersonation: true, authorize: () => ({ sections: ["auth:read"] }) })
    expect((await operation("auth.users")).status).toBe(200)
    const impersonate = await manage({ action: "impersonate", userId: "user-1" })
    expect(impersonate.status).toBe(403)
    expect(await impersonate.json()).toEqual({ message: "This Console access can read Auth data but not change it." })
    const ban = await operation("auth.ban", { userId: "user-1" })
    expect(ban.status).toBe(403)
    expect(await ban.json()).toMatchObject({ code: "CONSOLE_ACCESS_DENIED", message: expect.stringContaining("read-only") })
    expect(inspect.execute).not.toHaveBeenCalled()
  })

  it("starts and stops impersonation, restores the admin session, and records both events", async () => {
    const app = await consoleEventsFixture()
    closers.push(() => app.database.sqlite.close())
    state.inspect = createAuthConsole(app.auth, {}, app.store, { impersonation: true })
    installConsoleSections("impersonation-route", ["auth"])
    installConsoleAccess({ mode: "open", impersonation: true, authorize: () => ({ sections: ["auth"] }) })

    const described = await (await operation("auth.describe", {}, app.operator.cookie)).json()
    expect(state.host).toEqual({ impersonation: true })
    expect(described).toMatchObject({ value: { actions: { impersonate: { enabled: true } }, impersonation: { duration: 3600, active: null } } })
    expect(await (await operation("auth.user", { id: app.member.id }, app.operator.cookie)).json()).toMatchObject({ value: { impersonation: { enabled: true } } })

    const started = await manage({ action: "impersonate", userId: app.member.id }, app.operator.cookie)
    expect(started.status).toBe(200)
    const impersonating = jar(app.operator.cookie, started)
    const session = (cookie: string) => app.auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } })
    expect(await session(impersonating)).toMatchObject({ user: { id: app.member.id }, session: { impersonatedBy: app.operator.id } })
    expect(await (await operation("auth.describe", {}, impersonating)).json()).toMatchObject({
      value: { impersonation: { active: { user: { id: app.member.id, name: "Ada Lovelace" } } } },
    })

    const stopped = await manage({ action: "stopImpersonating" }, impersonating)
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ action: "stopImpersonating", ok: true })
    expect(await session(jar(impersonating, stopped))).toMatchObject({ user: { id: app.operator.id } })
    for (const type of ["impersonation.started", "impersonation.stopped"] as const)
      expect((await app.store.list({ type })).events, type).toEqual([expect.objectContaining({ actor: `user:${app.operator.id}`, userId: app.member.id })])
  })
})

describe("App Auth Console during impersonation", () => {
  const origin = "https://app.example.com"
  const mount = "/portal"

  async function setup(session?: { onRefresh: AuthSessionRefresh, updateAge: number }) {
    const database = new DatabaseSync(":memory:")
    closers.push(() => database.close())
    const routes: Parameters<typeof createAuthAccessHandler>[0] = [{ route: `${mount}/_vitehub/**`, authorize: true }, { route: `${mount}/_vitehub/api/**`, authorize: true }]
    // Every signed-in user passes the access routes, so only the impersonation check keeps the Console closed.
    const definition = defineAuth(() => ({
      baseURL: origin,
      basePath: `${mount}/api/auth`,
      database,
      secret: "test-secret-at-least-32-bytes-long",
      emailAndPassword: { enabled: true },
      plugins: [adminPlugin()],
      session,
      access: { routes: routes.map(route => ({ route: route.route, authorize: () => true })) },
    }))
    const authForRequest = (request: Pick<Request, "headers" | "url">) => createAuthForRequest(definition, request)
    const auth = authForRequest(new Request(origin))
    await (await auth.$context).runMigrations()
    const access = createConsoleAppAuthAccess({
      authForRequest: authForRequest,
      impersonation: true,
      requireAuthAccessRoutes: (event, indexes, _definition, required, options) => {
        return requireAuthAccessRoutes(event, indexes, definition, required, options)
      },
      requireSession: event => withAuthorization(true, () => undefined, definition)(event),
      routes: routes.map((route, index) => ({ ...route, index, authorize: true })),
    })
    const pages = createConsoleAppAuthPages(authForRequest)
    installConsoleAccess({ mode: "auth", impersonation: true, ...pages, ...access })
    const app = new H3()
      .use(createAuthAccessHandler(routes, definition))
      // Stands in for a Console data route that app Auth protects.
      .get(`${mount}/_vitehub/**`, () => new Response("protected"))
    const post = (path: string, body: object, cookie = "") => auth.handler(new Request(`${origin}${mount}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify(body),
    }))
    const signUp = async (name: string) => {
      const response = await post("sign-up/email", { name, email: `${name.toLowerCase()}@example.com`, password: "test-password-123" })
      expect(response.status).toBe(200)
      return { id: ((await response.json()) as { user: { id: string } }).user.id, cookie: jar("", response) }
    }
    const operator = await signUp("Operator")
    database.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(operator.id)
    const member = await signUp("Member")
    const visit = (path: string, cookie: string) => app.fetch(new Request(`${origin}${mount}${path}`, { headers: { accept: "application/json", cookie } }))
    return { access, operator, member, pages, post, visit }
  }

  it("closes Console data during impersonation, shows the way back, and opens it again after the stop", async () => {
    const { access, operator, member, pages, post, visit } = await setup()
    const sections = (cookie: string) => access.check(requestEvent(new Request(`${origin}${mount}/_vitehub/api/sections`, { headers: { cookie } })))
    expect((await visit("/_vitehub/api/sections", operator.cookie)).status).toBe(200)
    expect(await sections(operator.cookie)).toBeUndefined()

    const started = await post("admin/impersonate-user", { userId: member.id }, operator.cookie)
    expect(started.status).toBe(200)
    const impersonating = jar(operator.cookie, started)

    const rejected = await access.check(requestEvent(new Request(`${origin}${mount}/_vitehub/api/sections`, { headers: { cookie: impersonating } })))
    expect(rejected?.status).toBe(403)
    expect(await rejected?.json()).toMatchObject({ code: "CONSOLE_IMPERSONATING" })

    const page = await pages.signIn(requestEvent(new Request(`${origin}${mount}/_vitehub/sign-in`, { headers: { cookie: impersonating } })), (await sections(impersonating))!)
    expect(page.status).toBe(403)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[\w-]+'/)
    const html = await page.text()
    expect(html).toContain("Viewing the app as Member")
    expect(html).toContain("member@example.com")
    expect(html).toContain(`"${mount}/api/auth/admin/stop-impersonating"`)
    expect(html).toContain(`"${mount}/_vitehub/auth/users?user=${member.id}"`)
    expect(html).toContain(`href="${mount}/"`)

    const window = new Window()
    closers.push(() => window.close())
    window.document.write(html)
    const assign = vi.fn()
    const fetch = vi.fn(async () => post("admin/stop-impersonating", {}, impersonating))
    runInNewContext(window.document.querySelector("script")!.textContent, { document: window.document, fetch, window: { location: { assign } } })
    window.document.querySelector<HTMLButtonElement>("button")!.click()
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(`${mount}/_vitehub/auth/users?user=${member.id}`))
    expect(fetch).toHaveBeenCalledWith(`${mount}/api/auth/admin/stop-impersonating`, {
      body: "{}", credentials: "same-origin", headers: { "content-type": "application/json" }, method: "POST",
    })
    const stopped = await fetch.mock.results[0]!.value
    expect(stopped.status).toBe(200)
    const restored = jar(impersonating, stopped)
    expect(await sections(restored)).toBeUndefined()
  })

  it("signs out a session that the app ends on refresh", async () => {
    // Every read refreshes the session, and the app ends it.
    const { operator, visit } = await setup({ updateAge: 0, onRefresh: ({ clear }) => clear() })
    const data = await visit("/_vitehub/api/sections", operator.cookie)
    expect(data.status).toBe(401)
    expect(data.headers.get("location")).toBeNull()
  })
})
