import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import hubAuthNuxt from "../src/nuxt.ts"

import type { AuthPageMeta } from "../src/nuxt-types.ts"
import type { createAuthClient } from "../src/vue.ts"

type Route = { path: string, fullPath: string, meta: { auth?: AuthPageMeta } }
type Middleware = (route: Route) => unknown
type PublicConfig = { vitehubAuth?: false | { basePath?: string, redirects?: { login: string, guest: string } } }

const mocks = vi.hoisted(() => ({
  config: {} as { public?: PublicConfig },
  state: { value: undefined as unknown },
  event: { req: { headers: new Headers() }, res: { headers: new Headers() } },
  payload: {} as { prerenderedAt?: number },
  requestFetch: vi.fn(),
  getSession: vi.fn(),
  useSession: vi.fn(),
  createAuthClient: vi.fn(),
  navigateTo: vi.fn((target: unknown) => target),
  middleware: undefined as Middleware | undefined,
}))

vi.mock("#app", () => ({
  defineNuxtPlugin: (plugin: unknown) => plugin,
  addRouteMiddleware: (_name: string, middleware: Middleware) => { mocks.middleware = middleware },
  navigateTo: mocks.navigateTo,
  tryUseNuxtApp: () => ({ runWithContext: <T>(run: () => T) => run() }),
  useRequestEvent: () => mocks.event,
  useRequestFetch: () => mocks.requestFetch,
  useRuntimeConfig: () => mocks.config,
  useState: () => mocks.state,
}))

vi.mock("better-auth/vue", () => ({
  createAuthClient: (options: unknown) => {
    mocks.createAuthClient(options)
    return { getSession: mocks.getSession, useSession: mocks.useSession }
  },
}))

const { default: plugin } = await import("../src/runtime/vue-nuxt.ts") as {
  default: { setup: (app: { payload: typeof mocks.payload }) => Promise<{ provide: { vitehubAuthClient: ReturnType<typeof createAuthClient> } } | undefined> }
}
const roots: string[] = []
const session = { session: { id: "s", token: "secret", expiresAt: "2027-01-01T00:00:00.000Z" }, user: { id: "u" } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.config = { public: { vitehubAuth: { redirects: { login: "/login", guest: "/" } } } }
  mocks.state.value = undefined
  mocks.event = { req: { headers: new Headers({ cookie: "vitehub_session=1" }) }, res: { headers: new Headers() } }
  mocks.payload = {}
  mocks.middleware = undefined
  mocks.getSession.mockResolvedValue({ data: session })
  mocks.useSession.mockReturnValue(ref({ data: null, isPending: true }))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function configure(basePath?: string, appBaseURL = "/") {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-auth-session-"))
  roots.push(rootDir)
  await mkdir(join(rootDir, "server"))
  await writeFile(join(rootDir, "server/auth.ts"), `import { defineAuth } from "@vite-hub/auth"\nexport default defineAuth(${JSON.stringify({ appName: "Test", basePath })})\n`)
  const nuxt = { options: { rootDir, app: { baseURL: appBaseURL }, runtimeConfig: {} as { public?: PublicConfig } } }
  hubAuthNuxt({ env: false }, nuxt)
  mocks.config = nuxt.options.runtimeConfig
  vi.stubGlobal("__VITEHUB_AUTH_APP_BASE_URL__", appBaseURL)
}

const userPage: Route = { path: "/private", fullPath: "/private", meta: { auth: "user" } }
const guestPage: Route = { path: "/login", fullPath: "/login", meta: { auth: "guest" } }

/** Sets up the plugin as the browser, with the cookies that page scripts can read. */
async function setupBrowser(cookie = "", payload: { prerenderedAt?: number, isCached?: boolean } = {}) {
  vi.stubGlobal("window", {})
  vi.stubGlobal("document", { cookie })
  await plugin.setup({ payload })
}

describe("Nuxt session and page guard", () => {
  it.each(["server", "browser"])("skips session requests and middleware when Auth is disabled in the %s", async (host) => {
    mocks.config = { public: { vitehubAuth: false } }
    if (host === "browser") vi.stubGlobal("window", {})

    await plugin.setup({ payload: mocks.payload })

    expect(mocks.middleware).toBeUndefined()
    expect(mocks.requestFetch).not.toHaveBeenCalled()
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
    expect(mocks.state.value).toBeUndefined()
  })

  it.each([
    [undefined, "/", "/api/auth"],
    ["/auth", "/", "/auth"],
    ["/auth", "/app/", "/app/auth"],
    ["/app/auth", "/app/", "/app/auth"],
  ])("allows an authenticated SSR page with Auth %s below %s", async (basePath, appBaseURL, mountedPath) => {
    await configure(basePath, appBaseURL)
    mocks.requestFetch.mockImplementation(async (path: string, options: { onResponse: (input: { response: Response }) => void }) => {
      if (path !== `${mountedPath}/get-session`) throw new Error("404")
      options.onResponse({ response: new Response(null, { headers: { "set-cookie": "refreshed=1; HttpOnly" } }) })
      return session
    })

    await plugin.setup({ payload: mocks.payload })

    expect(mocks.requestFetch).toHaveBeenCalledWith(`${mountedPath}/get-session`, expect.anything())
    expect(mocks.middleware?.(userPage)).toBeUndefined()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(mocks.state.value).toEqual({ session: { id: "s", expiresAt: new Date(session.session.expiresAt) }, user: session.user })
    expect(mocks.event.res.headers.getSetCookie()).toEqual(["refreshed=1; HttpOnly"])
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
    expect(mocks.middleware?.(guestPage)).toBe("/")
  })

  it("skips the session lookup for a signed-out SSR request and redirects synchronously", async () => {
    mocks.event.req.headers.delete("cookie")
    await plugin.setup({ payload: mocks.payload })

    expect(mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(mocks.requestFetch).not.toHaveBeenCalled()
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
  })

  it("reads an unknown session once from the configured client endpoint without session watchers", async () => {
    await configure("/auth", "/app/")
    await setupBrowser("vitehub_session=1")

    for (let i = 0; i < 3; i++) expect(await mocks.middleware?.(userPage)).toBeUndefined()

    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/app/auth" })
    expect(mocks.useSession).not.toHaveBeenCalled()
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
  })

  it("decides browser navigations from the session that the server read", async () => {
    mocks.state.value = session
    await setupBrowser("vitehub_session=1")

    for (let i = 0; i < 3; i++) expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(await mocks.middleware?.(guestPage)).toBe("/")

    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
  })

  it("redirects a signed-out visitor and opens the login page without a session read", async () => {
    mocks.state.value = null
    await setupBrowser()

    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(await mocks.middleware?.(guestPage)).toBeUndefined()

    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it("reads the session again when the session cookie shows a sign-in", async () => {
    mocks.state.value = null
    await setupBrowser("vitehub_session=1")

    for (let i = 0; i < 2; i++) expect(await mocks.middleware?.(userPage)).toBeUndefined()

    expect(mocks.getSession).toHaveBeenCalledTimes(1)
  })

  it("reads the session again when the session cookie shows a sign-out", async () => {
    mocks.state.value = session
    mocks.getSession.mockResolvedValue({ data: null })
    await setupBrowser()

    expect(await mocks.middleware?.(guestPage)).toBeUndefined()
    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })

    expect(mocks.getSession).toHaveBeenCalledTimes(1)
  })

  it("provides the configured client for browser composables", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    const result = await plugin.setup({ payload: mocks.payload })
    await result!.provide.vitehubAuthClient.getSession()
    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/app/auth" })
  })

  it.each([
    ["prerendered", { prerenderedAt: 1 }],
    ["cached", { isCached: true }],
  ])("reads the session of a %s page once", async (_, payload) => {
    mocks.state.value = null
    await setupBrowser("vitehub_session=1", payload)

    for (let i = 0; i < 2; i++) expect(await mocks.middleware?.(userPage)).toBeUndefined()

    expect(mocks.getSession).toHaveBeenCalledTimes(1)
  })

  it("reads the session again when the known session expires", async () => {
    mocks.state.value = { ...session, session: { ...session.session, expiresAt: new Date("2027-01-01T00:00:00.000Z") } }
    mocks.getSession.mockResolvedValue({ data: { ...session, session: { ...session.session, expiresAt: new Date("2027-02-01T00:00:00.000Z") } } })
    await setupBrowser("vitehub_session=1")
    vi.useFakeTimers({ now: new Date("2026-12-31T23:59:59.000Z") })

    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(mocks.getSession).not.toHaveBeenCalled()

    vi.setSystemTime(new Date("2027-01-01T00:00:00.000Z"))
    for (let i = 0; i < 2; i++) expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(mocks.getSession).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date("2027-02-01T00:00:00.000Z"))
    mocks.getSession.mockResolvedValue({ data: null })
    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(mocks.getSession).toHaveBeenCalledTimes(2)
  })

  it("reads the session again after a failed read", async () => {
    mocks.getSession.mockResolvedValueOnce({ data: null, error: { status: 500 } })
    await setupBrowser("vitehub_session=1")

    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(await mocks.middleware?.(userPage)).toBeUndefined()

    expect(mocks.getSession).toHaveBeenCalledTimes(2)
  })

  it("keeps the redirectTo of a page", async () => {
    mocks.state.value = null
    await setupBrowser()

    expect(await mocks.middleware?.({ path: "/team", fullPath: "/team", meta: { auth: { only: "user", redirectTo: "/join" } } })).toEqual({ path: "/join", query: { redirect: "/team" } })
  })

  it.each([
    ["server", "user", null, { only: "user", redirectTo: "/private" }],
    ["browser", "user", null, { only: "user", redirectTo: "/private" }],
    ["server", "guest", session, { only: "guest", redirectTo: "/login" }],
    ["browser", "guest", session, { only: "guest", redirectTo: "/login" }],
  ] as const)("does not redirect a %s %s page to itself", async (host, _, state, auth) => {
    mocks.state.value = state
    mocks.getSession.mockResolvedValue({ data: state })
    if (host === "browser") await setupBrowser(state ? "vitehub_session=1" : "")
    else await plugin.setup({ payload: mocks.payload })
    const path = auth.only === "user" ? "/private" : "/login"

    expect(await mocks.middleware?.({ path, fullPath: `${path}?tab=1`, meta: { auth } })).toBeUndefined()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })
})
