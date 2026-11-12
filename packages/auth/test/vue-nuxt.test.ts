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
  requestFetch: vi.fn(),
  createError: vi.fn(() => new Error("nuxt")),
  getSession: vi.fn(),
  useSession: vi.fn(),
  createAuthClient: vi.fn(),
  sessionPaths: [] as unknown[],
  nuxtApp: { runWithContext: <T>(run: () => T) => run() } as { runWithContext<T>(run: () => T): T, $vitehubAuthClient?: unknown },
  navigateTo: vi.fn((target: unknown) => target),
  middleware: undefined as Middleware | undefined,
}))

vi.mock("#app", () => ({
  createError: mocks.createError,
  defineNuxtPlugin: (plugin: unknown) => plugin,
  addRouteMiddleware: (_name: string, middleware: Middleware) => { mocks.middleware = middleware },
  navigateTo: mocks.navigateTo,
  tryUseNuxtApp: () => mocks.nuxtApp,
  useRequestEvent: () => mocks.event,
  useRequestFetch: () => mocks.requestFetch,
  useRuntimeConfig: () => mocks.config,
  useState: () => mocks.state,
}))

vi.mock("better-auth/vue", () => ({
  createAuthClient: (options: unknown) => {
    mocks.createAuthClient(options)
    return {
      getSession: (...args: unknown[]) => {
        mocks.sessionPaths.push((options as { basePath?: string } | undefined)?.basePath)
        return mocks.getSession(...args)
      },
      useSession: mocks.useSession,
    }
  },
}))

vi.mock("#vitehub/auth/abilities", () => import("./fixtures/abilities.ts"))

const { useAbility } = await import("../src/vue.ts")
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
  mocks.nuxtApp = { runWithContext: run => run() }
  mocks.getSession.mockResolvedValue({ data: session })
  mocks.useSession.mockReturnValue(ref({ data: null, isPending: true }))
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

  it("makes a refusal of authorize() Nuxt's fatal error, with the status and data of the server", async () => {
    mocks.event.req.headers.delete("cookie")
    await plugin.setup({ payload: mocks.payload })

    const refused = await useAbility().authorize("posts.edit", { authorId: "u", published: true }).catch((error: unknown) => error)
    expect(mocks.createError).toHaveBeenCalledWith({ status: 401, statusText: "Unauthorized", message: "Unauthorized.", data: { code: "signed-out", details: undefined }, fatal: true })
    expect(refused).toBe(mocks.createError.mock.results[0]!.value)
  })

  it("makes authorize() in the browser read the session at the configured Auth endpoint, as the page guard does", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    mocks.state.value = null
    const result = await plugin.setup({ payload: mocks.payload })
    // Nuxt adds what the plugin provides to the app as `$vitehubAuthClient`.
    mocks.nuxtApp.$vitehubAuthClient = result!.provide.vitehubAuthClient
    const ability = useAbility()
    // Vitest can answer two concurrent first imports of a mocked module with the real one, so let `useAbility()` load it first.
    await vi.waitFor(() => expect(mocks.useSession).toHaveBeenCalled())
    mocks.sessionPaths = []
    mocks.getSession.mockResolvedValue({ data: session })

    await expect(ability.authorize("posts.edit", { authorId: "u", published: true })).resolves.toBeUndefined()
    expect(mocks.sessionPaths).toEqual(["/app/auth"])
  })

  it("skips the session lookup for a signed-out SSR request and redirects synchronously", async () => {
    mocks.event.req.headers.delete("cookie")
    await plugin.setup({ payload: mocks.payload })

    expect(mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(mocks.requestFetch).not.toHaveBeenCalled()
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
  })

  it("checks the configured client endpoint on every navigation without session watchers", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    mocks.state.value = null
    await plugin.setup({ payload: mocks.payload })

    for (let i = 0; i < 3; i++) expect(await mocks.middleware?.(userPage)).toBeUndefined()

    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/app/auth" })
    expect(mocks.useSession).not.toHaveBeenCalled()
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

  it("checks repeated navigations without installing session hooks", async () => {
    vi.stubGlobal("window", {})
    mocks.state.value = null
    await plugin.setup({ payload: mocks.payload })

    for (let i = 0; i < 3; i++) await mocks.middleware?.(userPage)

    expect(mocks.useSession).not.toHaveBeenCalled()
  })
})
