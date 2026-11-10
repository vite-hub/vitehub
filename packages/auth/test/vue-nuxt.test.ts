import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import hubAuthNuxt from "../src/nuxt.ts"

import type { AuthPageMeta } from "../src/nuxt-types.ts"
import type { createAuthClient } from "../src/vue.ts"

type Route = { fullPath: string, meta: { auth?: AuthPageMeta } }
type Middleware = (route: Route) => unknown
type PublicConfig = { vitehubAuth?: false | { basePath?: string, redirects?: { login: string, guest: string } } }

const mocks = vi.hoisted(() => ({
  config: {} as { public?: PublicConfig },
  state: { value: undefined as unknown },
  event: { req: { headers: new Headers() }, res: { headers: new Headers() } },
  payload: {} as { prerenderedAt?: number },
  app: { runWithContext: <T>(run: () => T): T => run() },
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
  tryUseNuxtApp: () => mocks.app,
  useRequestEvent: () => mocks.event,
  useRequestFetch: () => mocks.requestFetch,
  useRuntimeConfig: () => mocks.config,
  useState: () => mocks.state,
}))

// Better Auth's client, with a session atom that its `refetch()` fills from `getSession()`, as Better Auth does.
vi.mock("better-auth/vue", () => ({
  createAuthClient: (options: unknown) => {
    mocks.createAuthClient(options)
    const atom = ref<Record<string, unknown>>({})
    const refetch = async () => {
      const { data } = await mocks.getSession()
      atom.value = { data, error: null, isPending: false, isRefetching: false, refetch }
    }
    atom.value = { data: null, error: null, isPending: true, isRefetching: false, refetch }
    return {
      getSession: mocks.getSession,
      useSession: () => {
        mocks.useSession()
        return atom
      },
    }
  },
}))

type Plugin = { setup: (app: { payload: typeof mocks.payload }) => Promise<{ provide: { vitehubAuthClient: ReturnType<typeof createAuthClient> } } | undefined> }
// Each test gets new modules, so the default client and its session start empty.
let plugin: Plugin
let useUserSession: typeof import("../src/vue.ts").useUserSession
const roots: string[] = []
const session = { session: { id: "s", token: "secret", expiresAt: "2027-01-01T00:00:00.000Z" }, user: { id: "u" } }

beforeEach(async () => {
  vi.resetModules()
  plugin = (await import("../src/runtime/vue-nuxt.ts") as { default: Plugin }).default
  ;({ useUserSession } = await import("../src/vue.ts"))
  vi.clearAllMocks()
  mocks.config = { public: { vitehubAuth: { redirects: { login: "/login", guest: "/" } } } }
  mocks.state.value = undefined
  mocks.event = { req: { headers: new Headers({ cookie: "vitehub_session=1" }) }, res: { headers: new Headers() } }
  mocks.payload = {}
  mocks.middleware = undefined
  mocks.getSession.mockResolvedValue({ data: session })
})

afterEach(async () => {
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

const userPage: Route = { fullPath: "/private", meta: { auth: "user" } }

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
    expect(mocks.middleware?.({ fullPath: "/login", meta: { auth: "guest" } })).toBe("/")
  })

  it("skips the session lookup for a signed-out SSR request and redirects synchronously", async () => {
    mocks.event.req.headers.delete("cookie")
    await plugin.setup({ payload: mocks.payload })

    expect(mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(mocks.requestFetch).not.toHaveBeenCalled()
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
  })

  it("reads the session at the configured endpoint on every navigation, with one client and one subscription", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    mocks.state.value = null
    await plugin.setup({ payload: mocks.payload })

    for (let i = 0; i < 3; i++) expect(await mocks.middleware?.(userPage)).toBeUndefined()
    useUserSession()

    expect(mocks.createAuthClient).toHaveBeenCalledOnce()
    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/app/auth" })
    expect(mocks.useSession).toHaveBeenCalledOnce()
    expect(mocks.getSession).toHaveBeenCalledTimes(3)
    mocks.state.value = session
    mocks.getSession.mockResolvedValue({ data: null })
    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
  })

  it("provides the configured client for browser composables", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    const result = await plugin.setup({ payload: mocks.payload })
    await result!.provide.vitehubAuthClient.getSession()
    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/app/auth" })
  })

  it("updates useUserSession() with the answer of a guard read", async () => {
    vi.stubGlobal("window", {})
    // The server rendered the page signed in. The session then ended, such as by a sign-out in another tab.
    mocks.state.value = session
    await plugin.setup({ payload: mocks.payload })
    const { loggedIn, user } = useUserSession()
    expect(user.value).toEqual(session.user)
    mocks.getSession.mockResolvedValue({ data: null })

    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })

    expect(user.value).toBeNull()
    expect(loggedIn.value).toBe(false)
  })
})
