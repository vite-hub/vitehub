import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSSRApp, defineComponent, h, ref, watch } from "vue"
import { renderToString } from "vue/server-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import hubAuthNuxt from "../src/nuxt.ts"

import type { AuthPageMeta } from "../src/nuxt-types.ts"

type Route = { path: string, fullPath: string, meta: { auth?: AuthPageMeta } }
type Middleware = (route: Route) => unknown
type App = { runWithContext: <T>(run: () => T) => T, payload: { prerenderedAt?: number }, $vitehubAuthClient?: unknown }
type PublicConfig = { vitehubAuth?: false | { basePath?: string, redirects?: { login: string, guest: string } } }

const mocks = vi.hoisted(() => ({
  config: {} as { app?: { baseURL: string }, public?: PublicConfig },
  state: { value: undefined as unknown },
  event: { req: { headers: new Headers() }, res: { headers: new Headers() } },
  payload: {} as { prerenderedAt?: number },
  app: {} as App,
  requestFetch: vi.fn(),
  createError: vi.fn(() => new Error("nuxt")),
  getSession: vi.fn(),
  useSession: vi.fn(),
  createAuthClient: vi.fn(),
  sessionPaths: [] as unknown[],
  navigateTo: vi.fn((target: unknown) => target),
  signOut: vi.fn(),
  currentRoute: { value: { path: "/", fullPath: "/", meta: {} } as Route },
  middleware: undefined as Middleware | undefined,
  named: {} as Record<string, Middleware>,
}))

vi.mock("#app", () => ({
  createError: mocks.createError,
  defineNuxtPlugin: (plugin: unknown) => plugin,
  addRouteMiddleware: (name: string, middleware: Middleware, options?: { global?: boolean }) => {
    if (options?.global) mocks.middleware = middleware
    else mocks.named[name] = middleware
  },
  navigateTo: mocks.navigateTo,
  tryUseNuxtApp: () => mocks.app,
  useRequestEvent: () => mocks.event,
  useRequestFetch: () => mocks.requestFetch,
  useRouter: () => ({ currentRoute: mocks.currentRoute }),
  useRuntimeConfig: () => mocks.config,
  useState: () => mocks.state,
}))

vi.mock("#vitehub/auth/abilities", () => import("./fixtures/abilities.ts"))

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
      getSession: (...args: unknown[]) => {
        mocks.sessionPaths.push((options as { basePath?: string } | undefined)?.basePath)
        return mocks.getSession(...args)
      },
      signOut: mocks.signOut,
      useSession: () => {
        mocks.useSession()
        return atom
      },
    }
  },
}))

// The app's `auth.client.ts`, which `hubAuth()` serves as `#vitehub/auth/client`.
vi.mock("#vitehub/auth/client", () => ({ default: { plugins: [{ id: "admin-client" }] } }))

type Plugin = { setup: (app: { payload: typeof mocks.payload, runWithContext?: <T>(run: () => T) => T }) => { provide: { vitehubAuthClient: ReturnType<typeof createAuthClient> } } | undefined }
// Each test gets new modules, so the default client and its session start empty.
let plugin: Plugin
let Can: typeof import("../src/vue.ts").Can
let createAuthClient: typeof import("../src/vue.ts").createAuthClient
let setSignOutHandler: typeof import("../src/vue.ts").setSignOutHandler
let useAbility: typeof import("../src/vue.ts").useAbility
let useUserSession: typeof import("../src/vue.ts").useUserSession
const roots: string[] = []
const session = { session: { id: "s", token: "secret", expiresAt: "2027-01-01T00:00:00.000Z" }, user: { id: "u" } }

beforeEach(async () => {
  vi.resetModules()
  plugin = (await import("../src/runtime/vue-nuxt.ts") as { default: Plugin }).default
  ;({ Can, createAuthClient, setSignOutHandler, useAbility, useUserSession } = await import("../src/vue.ts"))
  vi.clearAllMocks()
  mocks.config = { public: { vitehubAuth: { redirects: { login: "/login", guest: "/" } } } }
  mocks.state = { value: undefined }
  mocks.event = { req: { headers: new Headers({ cookie: "vitehub_session=1" }) }, res: { headers: new Headers() } }
  mocks.payload = {}
  mocks.app = { runWithContext: run => run(), payload: mocks.payload }
  mocks.middleware = undefined
  mocks.named = {}
  mocks.getSession.mockResolvedValue({ data: session })
  mocks.signOut.mockResolvedValue({ data: { success: true }, error: null })
  mocks.currentRoute.value = { path: "/", fullPath: "/", meta: {} }
})

afterEach(async () => {
  setSignOutHandler(undefined)
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

/** Renders a page on the server with `count` components that call `useUserSession()`. */
function renderPage(count: number): Promise<string> {
  const User = defineComponent(() => {
    const { user } = useUserSession()
    return () => h("span", user.value?.id ?? "guest")
  })
  return renderToString(createSSRApp(() => h("main", Array.from({ length: count }, () => h(User)))))
}

describe("Nuxt session and page guard", () => {
  it.each(["server", "browser"])("skips session requests and middleware when Auth is disabled in the %s", async (host) => {
    mocks.config = { public: { vitehubAuth: false } }
    if (host === "browser") vi.stubGlobal("window", {})

    await plugin.setup({ payload: mocks.payload })

    expect(mocks.middleware).toBeUndefined()
    expect(mocks.named).toEqual({})
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

    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(mocks.requestFetch).toHaveBeenCalledWith(`${mountedPath}/get-session`, expect.anything())
    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(mocks.state.value).toEqual({ session: { id: "s", expiresAt: new Date(session.session.expiresAt) }, user: session.user })
    expect(mocks.event.res.headers.getSetCookie()).toEqual(["refreshed=1; HttpOnly"])
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
    expect(mocks.middleware?.({ path: "/login", fullPath: "/login", meta: { auth: "guest" } })).toBe("/")
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
    mocks.app.$vitehubAuthClient = result!.provide.vitehubAuthClient
    const ability = useAbility()
    // Vitest can answer two concurrent first imports of a mocked module with the real one, so load it first. The server
    // rendered the page signed out, so `useAbility()` does not load Better Auth itself.
    await result!.provide.vitehubAuthClient.getSession()
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

  it("does not read the session for an SSR page without a page guard or a session composable", async () => {
    await plugin.setup(mocks.app)

    expect(await mocks.middleware?.({ path: "/", fullPath: "/", meta: {} })).toBeUndefined()
    expect(await renderPage(0)).toBe("<main></main>")
    expect(mocks.requestFetch).not.toHaveBeenCalled()
    expect(mocks.state.value).toBeUndefined()
  })

  it("reads the session once for an SSR page with a page guard and session composables", async () => {
    mocks.requestFetch.mockResolvedValue(session)
    await plugin.setup(mocks.app)

    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(await renderPage(2)).toBe("<main><span>u</span><span>u</span></main>")
    expect(mocks.requestFetch).toHaveBeenCalledTimes(1)
    expect(mocks.state.value).toEqual({ session: { id: "s", expiresAt: new Date(session.session.expiresAt) }, user: session.user })
  })

  it("reads the session once for SSR components without a page guard, and renders the user", async () => {
    mocks.requestFetch.mockResolvedValue(session)
    await plugin.setup(mocks.app)

    expect(await renderPage(2)).toBe("<main><span>u</span><span>u</span></main>")
    expect(mocks.requestFetch).toHaveBeenCalledTimes(1)
    // The payload seeds the browser's composables, without the session token.
    expect(mocks.state.value).toEqual({ session: { id: "s", expiresAt: new Date(session.session.expiresAt) }, user: session.user })
  })

  it("reads the session once for SSR <Can> components, and renders what the rule allows", async () => {
    mocks.requestFetch.mockResolvedValue(session)
    await plugin.setup(mocks.app)
    const can = (authorId: string) => h(Can as never, { do: "posts.edit", with: { authorId, published: false } }, {
      default: () => h("button", "Edit"),
      denied: ({ code }: { code: string }) => h("span", code),
    })

    const html = await renderToString(createSSRApp(() => h("main", [can("u"), can("other")])))

    expect(html.replace(/<!--[[\]]-->/g, "")).toBe("<main><button>Edit</button><span>not-author</span></main>")
    expect(mocks.requestFetch).toHaveBeenCalledTimes(1)
  })

  it("settles the session for an SSR component whose async setup waits until the session is ready", async () => {
    mocks.requestFetch.mockResolvedValue(session)
    await plugin.setup(mocks.app)
    const User = defineComponent(async () => {
      const { ready, user, loggedIn } = useUserSession()
      // Vue runs `onServerPrefetch` only after async setup ends, so the read must settle the session without it.
      if (!ready.value) await new Promise<void>(resolve => watch(ready, value => value && resolve(), { flush: "sync" }))
      const id = user.value?.id
      return () => h("span", `${id}:${loggedIn.value}`)
    })
    const html = renderToString(createSSRApp(() => h("main", [h(User)])))
    const timeout = new Promise<string>(resolve => setTimeout(() => resolve("timeout"), 1000))

    expect(await Promise.race([html, timeout])).toBe("<main><span>u:true</span></main>")
    expect(mocks.requestFetch).toHaveBeenCalledTimes(1)
  })

  it("keeps the session read of each SSR request apart", async () => {
    mocks.requestFetch.mockResolvedValue(session)
    const first = { app: { ...mocks.app }, state: { value: undefined as unknown } }
    const second = { app: { ...mocks.app }, state: { value: undefined as unknown } }
    await plugin.setup(first.app)
    await plugin.setup(second.app)

    for (const request of [first, second]) {
      mocks.app = request.app
      mocks.state = request.state
      expect(await renderPage(1)).toBe("<main><span>u</span></main>")
    }
    expect(mocks.requestFetch).toHaveBeenCalledTimes(2)
    expect(first.state.value).toEqual(second.state.value)
  })

  it("reads the session at the configured endpoint on every navigation, with one client and one subscription", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    mocks.state.value = null
    await plugin.setup({ payload: mocks.payload })

    for (let i = 0; i < 3; i++) expect(await mocks.middleware?.(userPage)).toBeUndefined()
    useUserSession()

    expect(mocks.createAuthClient).toHaveBeenCalledOnce()
    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/app/auth", plugins: [{ id: "admin-client" }] })
    expect(mocks.useSession).toHaveBeenCalledOnce()
    expect(mocks.getSession).toHaveBeenCalledTimes(3)
    mocks.state.value = session
    mocks.getSession.mockResolvedValue({ data: null })
    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
  })

  it("gives createAuthClient() without basePath the same endpoint as the default client", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    await plugin.setup({ payload: mocks.payload })
    await createAuthClient({ plugins: [] }).getSession()
    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/app/auth", plugins: [] })
    mocks.createAuthClient.mockClear()
    await createAuthClient({ basePath: "/custom/auth" }).getSession()
    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/custom/auth" })
  })

  it("provides the configured client for browser composables", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    const result = await plugin.setup({ payload: mocks.payload })
    await result!.provide.vitehubAuthClient.getSession()
    expect(mocks.createAuthClient).toHaveBeenCalledWith(expect.objectContaining({ basePath: "/app/auth" }))
  })

  it("guards the pages of auth.routes with the named middleware that their route rules attach", async () => {
    mocks.event.req.headers.delete("cookie")
    await plugin.setup({ payload: mocks.payload })
    const page = (fullPath: string, auth?: AuthPageMeta): Route => ({ path: fullPath.split("?")[0]!, fullPath, meta: auth === undefined ? {} : { auth } })

    expect(Object.keys(mocks.named)).toEqual(["vitehub-auth-user", "vitehub-auth-guest"])
    // The global guard reads only page meta, so a page of the route map does not run the guard twice.
    expect(mocks.middleware?.(page("/dashboard"))).toBeUndefined()
    expect(mocks.named["vitehub-auth-user"]?.(page("/dashboard?tab=1"))).toEqual({ path: "/login", query: { redirect: "/dashboard?tab=1" } })
    expect(mocks.named["vitehub-auth-guest"]?.(page("/login"))).toBeUndefined()
    // definePageMeta({ auth }) wins over the route map.
    expect(mocks.named["vitehub-auth-user"]?.(page("/dashboard/public", false))).toBeUndefined()
    expect(mocks.named["vitehub-auth-user"]?.(page("/dashboard/guest", "guest"))).toBeUndefined()
    expect(mocks.middleware?.(page("/dashboard/guest", "guest"))).toBeUndefined()
  })

  it("does not redirect a page of a wide auth.routes pattern to itself", async () => {
    mocks.event.req.headers.delete("cookie")
    await plugin.setup({ payload: mocks.payload })

    // `'/**': 'user'` also covers the login page. A redirect to it would run the guard again on each request.
    expect(mocks.named["vitehub-auth-user"]?.({ path: "/login", fullPath: "/login?redirect=/settings", meta: {} })).toBeUndefined()
    expect(mocks.named["vitehub-auth-user"]?.({ path: "/settings", fullPath: "/settings", meta: {} })).toEqual({ path: "/login", query: { redirect: "/settings" } })
  })

  it("does not redirect a signed-in user from the guest redirect page to itself", async () => {
    await plugin.setup({ payload: mocks.payload })
    mocks.state.value = session

    expect(mocks.named["vitehub-auth-guest"]?.({ path: "/", fullPath: "/", meta: {} })).toBeUndefined()
  })

  it("sends a signed-in user away from a guest page of auth.routes in the browser", async () => {
    vi.stubGlobal("window", {})
    await plugin.setup({ payload: mocks.payload })

    expect(await mocks.named["vitehub-auth-guest"]?.({ path: "/login", fullPath: "/login", meta: {} })).toBe("/")
    expect(await mocks.named["vitehub-auth-user"]?.({ path: "/dashboard", fullPath: "/dashboard", meta: {} })).toBeUndefined()
    const { loggedIn, user } = useUserSession()
    expect(loggedIn.value).toBe(true)
    mocks.getSession.mockResolvedValue({ data: null })
    expect(await mocks.named["vitehub-auth-user"]?.({ path: "/dashboard", fullPath: "/dashboard", meta: {} })).toEqual({ path: "/login", query: { redirect: "/dashboard" } })
    expect(loggedIn.value).toBe(false)
    expect(user.value).toBeNull()
  })

  it("uses the client of the composables, with the plugins of auth.client.ts, in the page guard", async () => {
    // A new page load: no Better Auth client exists yet.
    vi.resetModules()
    const { useAuthClient, useUserSession } = await import("../src/vue.ts")
    const { default: plugin } = await import("../src/runtime/vue-nuxt.ts") as { default: Plugin }
    vi.stubGlobal("window", {})
    mocks.state.value = null
    await plugin.setup({ payload: mocks.payload })

    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    const { client } = useUserSession()
    await client.getSession()

    expect(client).toBe(useAuthClient())
    // One Better Auth client serves the guard and the page.
    expect(mocks.createAuthClient).toHaveBeenCalledTimes(1)
    expect(mocks.createAuthClient).toHaveBeenCalledWith(expect.objectContaining({ plugins: [{ id: "admin-client" }] }))
    expect(mocks.getSession).toHaveBeenCalledTimes(2)
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

describe("signOut() in Nuxt", () => {
  /** A signed-in browser that opened `route`, as the router and the page guard see it. */
  async function openInBrowser(route: Route) {
    vi.stubGlobal("window", {})
    mocks.state.value = session
    await plugin.setup({ payload: mocks.payload, runWithContext: run => run() })
    await mocks.middleware?.(route)
    mocks.currentRoute.value = route
    mocks.navigateTo.mockClear()
  }

  it("sends the visitor from a page for signed-in visitors to the login page, as the page guard does", async () => {
    await openInBrowser(userPage)

    await expect(useUserSession(createAuthClient()).signOut()).resolves.toEqual({ data: { success: true }, error: null })

    expect(mocks.signOut).toHaveBeenCalledOnce()
    expect(mocks.navigateTo).toHaveBeenCalledExactlyOnceWith({ path: "/login", query: { redirect: "/private" } })
    // A component that starts on the next page starts signed out.
    expect(mocks.state.value).toBeNull()
  })

  it("opens redirectTo with navigateTo on any page", async () => {
    await openInBrowser(userPage)

    await useUserSession(createAuthClient()).signOut({ redirectTo: "/goodbye" })

    expect(mocks.navigateTo).toHaveBeenCalledExactlyOnceWith("/goodbye", { external: false })
  })

  it.each([
    ["a page without a guard", { path: "/blog", fullPath: "/blog", meta: {} }],
    ["a page for guests", { path: "/login", fullPath: "/login", meta: { auth: "guest" as const } }],
  ])("keeps the visitor on %s", async (_name, route: Route) => {
    await openInBrowser(route)

    await useUserSession(createAuthClient()).signOut()

    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(mocks.state.value).toBeNull()
  })

  it("follows the page on screen when another middleware stopped a navigation", async () => {
    await openInBrowser(userPage)
    // The page guard allowed `/admin`, then another middleware stopped the navigation.
    await mocks.middleware?.({ path: "/admin", fullPath: "/admin", meta: { auth: "user" } })
    await mocks.middleware?.({ path: "/blog", fullPath: "/blog", meta: {} })
    mocks.navigateTo.mockClear()

    await useUserSession(createAuthClient()).signOut()

    expect(mocks.navigateTo).toHaveBeenCalledExactlyOnceWith({ path: "/login", query: { redirect: "/private" } })
  })

  it("opens a redirectTo on another site as an external page", async () => {
    await openInBrowser(userPage)

    await useUserSession(createAuthClient()).signOut({ redirectTo: "https://accounts.example.com/bye" })

    expect(mocks.navigateTo).toHaveBeenCalledExactlyOnceWith("https://accounts.example.com/bye", { external: true })
  })

  it("follows the page's own redirectTo", async () => {
    await openInBrowser({ path: "/team", fullPath: "/team", meta: { auth: { only: "user", redirectTo: "/join" } } })

    await useUserSession(createAuthClient()).signOut()

    expect(mocks.navigateTo).toHaveBeenCalledExactlyOnceWith({ path: "/join", query: { redirect: "/team" } })
  })
})

/** The Nuxt plugin and the Vue entry in new modules, so the default client has not loaded Better Auth yet. */
async function loadFreshModules() {
  vi.resetModules()
  const [{ default: freshPlugin }, vue] = await Promise.all([import("../src/runtime/vue-nuxt.ts") as Promise<{ default: typeof plugin }>, import("../src/vue.ts")])
  return { plugin: freshPlugin, vue }
}

describe("Nuxt default client", () => {
  it("calls the Definition's basePath below app.baseURL from the auto-imported composables, with the client of the page guard", async () => {
    await configure("/auth", "/app/")
    mocks.config.app = { baseURL: "/app/" }
    vi.stubGlobal("window", {})
    mocks.state.value = null
    const fresh = await loadFreshModules()
    await fresh.plugin.setup({ payload: mocks.payload })

    fresh.vue.useUserSession()
    // The server rendered the page signed out, so the composables wait. The page guard's read loads the client.
    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(mocks.useSession).toHaveBeenCalledOnce()

    // One Better Auth client serves the composables and the page guard.
    expect(mocks.createAuthClient.mock.calls).toEqual([[{ basePath: "/app/auth", plugins: [{ id: "admin-client" }] }]])
  })

  it("calls Auth below a runtime app.baseURL in the browser, such as one that NUXT_APP_BASE_URL sets", async () => {
    await configure("/auth", "/app/")
    mocks.config.app = { baseURL: "/preview/" }
    vi.stubGlobal("window", {})
    const fresh = await loadFreshModules()
    await fresh.plugin.setup({ payload: mocks.payload })

    await fresh.vue.useAuthClient().getSession()

    expect(mocks.createAuthClient.mock.calls).toEqual([[{ basePath: "/preview/auth", plugins: [{ id: "admin-client" }] }]])
  })

  it("reads the session on the server at the Nitro route, without the runtime app.baseURL that Nuxt's $fetch adds", async () => {
    await configure("/auth", "/app/")
    mocks.config.app = { baseURL: "/preview/" }
    mocks.requestFetch.mockResolvedValue(session)
    const fresh = await loadFreshModules()
    await fresh.plugin.setup({ payload: mocks.payload })
    // The page guard reads the session the first time that it needs it.
    expect(await mocks.middleware?.(userPage)).toBeUndefined()

    // Nitro compiles its routes below the base path of the build. With `/preview/`, the read would render a page.
    expect(mocks.requestFetch).toHaveBeenCalledWith("/app/auth/get-session", expect.objectContaining({ baseURL: "/" }))
  })
})
