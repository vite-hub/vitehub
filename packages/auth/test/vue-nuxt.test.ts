import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSSRApp, defineComponent, h, ref, watch } from "vue"
import { renderToString } from "vue/server-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import hubAuthNuxt from "../src/nuxt.ts"

import type { AuthPageMeta } from "../src/nuxt-types.ts"

type Route = { path?: string, redirectedFrom?: object, fullPath: string, matched?: readonly object[], params?: Record<string, unknown>, meta: { auth?: AuthPageMeta } }
type Middleware = (route: Route) => unknown
type App = { isHydrating?: boolean, runWithContext: <T>(run: () => T) => T, payload: { prerenderedAt?: number, isCached?: boolean, error?: unknown }, $vitehubAuthClient?: unknown }
type PublicConfig = { vitehubAuth?: false | { basePath?: string, signInPage?: string | null, afterSignIn?: string } }

const mocks = vi.hoisted(() => ({
  config: {} as { app?: { baseURL: string }, public?: PublicConfig },
  state: { value: undefined as unknown },
  guardRoute: { value: undefined as string | undefined },
  event: {} as { url: URL, req: { headers: Headers }, res: { headers: Headers } },
  payload: {} as { prerenderedAt?: number },
  app: {} as App,
  requestFetch: vi.fn<(request: Request) => Promise<Response>>(),
  createError: vi.fn(() => new Error("nuxt")),
  getSession: vi.fn(),
  useSession: vi.fn(),
  createAuthClient: vi.fn(),
  sessionPaths: [] as unknown[],
  navigateTo: vi.fn((target: unknown) => target),
  signOut: vi.fn(),
  showError: vi.fn(),
  currentRoute: { value: { fullPath: "/", meta: {} } as Route },
  // Vue Router's `strict`: without it, a trailing slash opens the same page.
  strictRoutes: false,
  pages: new Map<string, object>(),
  params: new Map<string, Record<string, unknown>>(),
  middleware: undefined as Middleware | undefined,
}))

/** Resolves a path to one page per path, as Vue Router does for static pages. */
function resolveRoute(target: string) {
  const path = target.replace(/[?#][^]*$/, "")
  const key = mocks.strictRoutes ? path : path.replace(/(.)\/$/, "$1")
  if (!mocks.pages.has(key)) mocks.pages.set(key, { path: key })
  return { matched: [mocks.pages.get(key)!], params: mocks.params.get(key) ?? {} }
}

vi.mock("nitro", () => ({ serverFetch: mocks.requestFetch }))

vi.mock("#app", () => ({
  createError: mocks.createError,
  defineNuxtPlugin: (plugin: unknown) => plugin,
  // Vue Router gives the guard the record that it matched. Tests that don't name one get the record of `fullPath`.
  addRouteMiddleware: (_name: string, middleware: Middleware) => { mocks.middleware = route => middleware({ ...resolveRoute(route.fullPath), ...route }) },
  navigateTo: mocks.navigateTo,
  showError: mocks.showError,
  tryUseNuxtApp: () => mocks.app,
  useRequestEvent: () => mocks.event,
  useRouter: () => ({ currentRoute: { get value() { return { ...resolveRoute(mocks.currentRoute.value.fullPath), ...mocks.currentRoute.value } } }, resolve: resolveRoute }),
  useRuntimeConfig: () => mocks.config,
  useState: (key: string) => key === "vitehub:auth:guard-route" ? mocks.guardRoute : mocks.state,
}))

vi.mock("#vitehub/auth/abilities", () => import("./fixtures/abilities.ts"))

// Better Auth's client, with a session atom that its `refetch()` fills from `getSession()`, as Better Auth does.
vi.mock("better-auth/vue", () => ({
  createAuthClient: (options: unknown) => {
    mocks.createAuthClient(options)
    const atom = ref<Record<string, unknown>>({})
    let latestRead = 0
    const refetch = async () => {
      const read = ++latestRead
      atom.value = { ...atom.value, isRefetching: true }
      const { data } = await mocks.getSession()
      if (read === latestRead) atom.value = { data, error: null, isPending: false, isRefetching: false, refetch }
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

type Plugin = { setup: (app: { isHydrating?: boolean, payload: typeof mocks.payload, runWithContext?: <T>(run: () => T) => T }) => void }
// Each test gets new modules, so the default client and its session start empty.
let plugin: Plugin
let authClient: typeof import("../src/vue.ts").authClient
let Can: typeof import("../src/vue.ts").Can
let createAuthClient: typeof import("../src/vue.ts").createAuthClient
let setSignOutHandler: typeof import("../src/vue.ts").setSignOutHandler
let useAbility: typeof import("../src/vue.ts").useAbility
let useUserSession: typeof import("../src/vue.ts").useUserSession
const roots: string[] = []
const session = { session: { id: "s", token: "secret", expiresAt: "2027-01-01T00:00:00.000Z" }, user: { id: "u" } }
const answer = (body: unknown) => async () => Response.json(body)
const sentPaths = () => mocks.requestFetch.mock.calls.map(([request]) => new URL(request.url).pathname)

beforeEach(async () => {
  vi.resetModules()
  plugin = (await import("../src/runtime/vue-nuxt.ts") as { default: Plugin }).default
  ;({ authClient, Can, createAuthClient, setSignOutHandler, useAbility, useUserSession } = await import("../src/vue.ts"))
  vi.clearAllMocks()
  mocks.config = { public: { vitehubAuth: { basePath: "/api/auth", signInPage: "/login", afterSignIn: "/" } } }
  mocks.state = { value: undefined }
  mocks.guardRoute.value = undefined
  mocks.requestFetch.mockImplementation(answer(null))
  mocks.event = {
    url: new URL("https://app.example.com/private"),
    req: { headers: new Headers({ cookie: "vitehub_session=1" }) },
    res: { headers: new Headers() },
  }
  mocks.payload = {}
  mocks.app = { runWithContext: run => run(), payload: mocks.payload }
  mocks.middleware = undefined
  mocks.getSession.mockResolvedValue({ data: session })
  mocks.signOut.mockResolvedValue({ data: { success: true }, error: null })
  mocks.currentRoute.value = { fullPath: "/", meta: {} }
  mocks.strictRoutes = false
  mocks.pages.clear()
  mocks.params.clear()
})

afterEach(async () => {
  setSignOutHandler(undefined)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function configure(basePath?: string, appBaseURL = "/", access?: Record<string, unknown>) {
  const rootDir = await mkdtemp(join(tmpdir(), "vitehub-auth-session-"))
  roots.push(rootDir)
  await mkdir(join(rootDir, "server"))
  await writeFile(join(rootDir, "server/auth.ts"), `import { defineAuth } from "@vite-hub/auth"\nexport default defineAuth(${JSON.stringify({ appName: "Test", basePath, access })})\n`)
  const nuxt = { options: { rootDir, app: { baseURL: appBaseURL }, runtimeConfig: {} as { public?: PublicConfig } } }
  hubAuthNuxt({ env: false }, nuxt)
  mocks.config = nuxt.options.runtimeConfig
  vi.stubGlobal("__VITEHUB_AUTH_APP_BASE_URL__", appBaseURL)
}

const userPage: Route = { path: "/private", fullPath: "/private", meta: { auth: "user" } }

const guestPage: Route = { path: "/login", fullPath: "/login", meta: { auth: "guest" } }

/** Sets up the plugin as the browser, with the cookies that page scripts can read. */
async function setupBrowser(cookie = "", payload: App["payload"] = {}, isHydrating = false): Promise<App> {
  vi.stubGlobal("window", {})
  vi.stubGlobal("document", { cookie })
  const app: App = { runWithContext: run => run(), isHydrating, payload }
  await plugin.setup(app)
  return app
}

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
    mocks.requestFetch.mockImplementation(async (request) => {
      if (new URL(request.url).pathname !== `${mountedPath}/get-session`) return new Response(null, { status: 404 })
      return Response.json(session, { headers: { "set-cookie": "refreshed=1; HttpOnly" } })
    })

    await plugin.setup({ payload: mocks.payload })

    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(sentPaths()).toEqual([`${mountedPath}/get-session`])
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
    await plugin.setup({ payload: mocks.payload })
    const ability = useAbility()
    // Vitest can answer two concurrent first imports of a mocked module with the real one, so load it first. The server
    // rendered the page signed out, so `useAbility()` does not load Better Auth itself.
    await authClient.getSession()
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

    expect(await mocks.middleware?.({ fullPath: "/", meta: {} })).toBeUndefined()
    expect(await renderPage(0)).toBe("<main></main>")
    expect(mocks.requestFetch).not.toHaveBeenCalled()
    expect(mocks.state.value).toBeUndefined()
  })

  it("reads the session once for an SSR page with a page guard and session composables", async () => {
    mocks.requestFetch.mockImplementation(answer(session))
    await plugin.setup(mocks.app)

    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(await renderPage(2)).toBe("<main><span>u</span><span>u</span></main>")
    expect(mocks.requestFetch).toHaveBeenCalledTimes(1)
    expect(mocks.state.value).toEqual({ session: { id: "s", expiresAt: new Date(session.session.expiresAt) }, user: session.user })
  })

  it("reads the session once for SSR components without a page guard, and renders the user", async () => {
    mocks.requestFetch.mockImplementation(answer(session))
    await plugin.setup(mocks.app)

    expect(await renderPage(2)).toBe("<main><span>u</span><span>u</span></main>")
    expect(mocks.requestFetch).toHaveBeenCalledTimes(1)
    // The payload seeds the browser's composables, without the session token.
    expect(mocks.state.value).toEqual({ session: { id: "s", expiresAt: new Date(session.session.expiresAt) }, user: session.user })
  })

  it("reads the session once for SSR <Can> components, and renders what the rule allows", async () => {
    mocks.requestFetch.mockImplementation(answer(session))
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
    mocks.requestFetch.mockImplementation(answer(session))
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
    mocks.requestFetch.mockImplementation(answer(session))
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

  it("gives the default client of the browser composables the configured endpoint", async () => {
    await configure("/auth", "/app/")
    vi.stubGlobal("window", {})
    await plugin.setup({ payload: mocks.payload })
    await authClient.getSession()
    expect(mocks.createAuthClient).toHaveBeenCalledWith(expect.objectContaining({ basePath: "/app/auth" }))
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
    ["a page without a guard", { fullPath: "/blog", meta: {} }],
    ["a page for guests", { fullPath: "/login", meta: { auth: "guest" as const } }],
  ])("keeps the visitor on %s", async (_name, route: Route) => {
    await openInBrowser(route)

    await useUserSession(createAuthClient()).signOut()

    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(mocks.state.value).toBeNull()
  })

  it("follows the page on screen when another middleware stopped a navigation", async () => {
    await openInBrowser(userPage)
    // The page guard allowed `/admin`, then another middleware stopped the navigation.
    await mocks.middleware?.({ fullPath: "/admin", meta: { auth: "user" } })
    await mocks.middleware?.({ fullPath: "/blog", meta: {} })
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
    await openInBrowser({ fullPath: "/team", meta: { auth: { only: "user", redirectTo: "/join" } } })

    await useUserSession(createAuthClient()).signOut()

    expect(mocks.navigateTo).toHaveBeenCalledExactlyOnceWith({ path: "/join", query: { redirect: "/team" } })
  })

  it("shows the signed-out error instead of the page when the sign-in page of the page is itself", async () => {
    await openInBrowser({ path: "/team", fullPath: "/team", meta: { auth: { only: "user", redirectTo: "/team" } } })

    await useUserSession(createAuthClient()).signOut()

    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showError).toHaveBeenCalledExactlyOnceWith({ statusCode: 401, statusMessage: "Signed out" })
  })

  it("does not navigate after provider sign-out, even on a protected app root", async () => {
    mocks.config = { public: { vitehubAuth: { basePath: "/api/auth", signInPage: null, afterSignIn: "/" } } }
    await openInBrowser({ ...userPage, fullPath: "/" })

    await useUserSession(createAuthClient()).signOut()

    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showError).toHaveBeenCalledExactlyOnceWith({ statusCode: 401, statusMessage: "Signed out" })
  })
})

describe("the page guard with access.signIn and access.afterSignIn of server/auth.ts", () => {
  it("opens the sign-in page, and sends a signed-in user from a guest page to afterSignIn", async () => {
    await configure(undefined, "/", { signIn: "/sign-in", afterSignIn: "/dashboard" })
    mocks.requestFetch.mockImplementation(answer(session))
    await plugin.setup({ payload: mocks.payload })

    expect(await mocks.middleware?.({ fullPath: "/login", meta: { auth: "guest" } })).toBe("/dashboard")
  })

  it("sends a signed-out visitor to the sign-in page", async () => {
    await configure(undefined, "/", { signIn: "/sign-in" })
    mocks.event.req.headers.delete("cookie")
    await plugin.setup({ payload: mocks.payload })

    expect(mocks.middleware?.(userPage)).toEqual({ path: "/sign-in", query: { redirect: "/private" } })
  })

  it("starts the provider sign-in of the Auth route below app.baseURL", async () => {
    await configure("/auth", "/app/", { signIn: { provider: "github" } })
    mocks.config = { ...mocks.config, app: { baseURL: "/app/" } }
    mocks.event.req.headers.delete("cookie")
    await plugin.setup({ payload: mocks.payload })

    expect(mocks.middleware?.({ fullPath: "/private?tab=1", meta: { auth: "user" } })).toBe("/app/auth/sign-in?redirect=%2Fprivate%3Ftab%3D1")
    expect(mocks.navigateTo).toHaveBeenCalledWith("/app/auth/sign-in?redirect=%2Fprivate%3Ftab%3D1", { external: true })
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

  it("reads the session on the server at the Nitro route, without the runtime app.baseURL", async () => {
    await configure("/auth", "/app/")
    mocks.config.app = { baseURL: "/preview/" }
    mocks.requestFetch.mockImplementation(answer(session))
    const fresh = await loadFreshModules()
    await fresh.plugin.setup({ payload: mocks.payload })
    // The page guard reads the session the first time that it needs it.
    expect(await mocks.middleware?.(userPage)).toBeUndefined()

    // Nitro compiles its routes below the base path of the build. With `/preview/`, the read would render a page.
    expect(sentPaths()).toEqual(["/app/auth/get-session"])
  })
})

describe("navigation session ownership", () => {
  it("decides the hydration of a page from the session that the server read", async () => {
    mocks.state.value = session
    await plugin.setup({ payload: mocks.payload })
    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    await setupBrowser("vitehub_session=1", {}, true)

    expect(await mocks.middleware?.({ ...userPage, fullPath: "/private#details" })).toBeUndefined()

    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
  })

  it("reads the browser session on a different page even while hydrating", async () => {
    mocks.state.value = session
    mocks.guardRoute.value = "/private"
    mocks.getSession.mockResolvedValue({ data: null })
    await setupBrowser("", {}, true)

    expect(await mocks.middleware?.(guestPage)).toBeUndefined()
    expect(mocks.getSession).toHaveBeenCalledOnce()
  })

  it("checks a signed-out server seed against cookies scoped to the auth endpoint", async () => {
    mocks.state.value = null
    await setupBrowser("", {}, true)

    expect(await mocks.middleware?.(guestPage)).toBe("/")
    expect(mocks.getSession).toHaveBeenCalledOnce()
  })

  it("waits for a newer Better Auth refresh before deciding a navigation", async () => {
    await setupBrowser()
    expect(await mocks.middleware?.(userPage)).toBeUndefined()

    let answerGuard: (value: unknown) => void = () => {}
    let answerRefresh: (value: unknown) => void = () => {}
    mocks.getSession.mockClear()
    mocks.getSession.mockReturnValueOnce(new Promise(resolve => { answerGuard = resolve }))
    mocks.getSession.mockReturnValueOnce(new Promise(resolve => { answerRefresh = resolve }))
    const navigation = mocks.middleware?.(userPage)
    await vi.waitFor(() => expect(mocks.getSession).toHaveBeenCalledTimes(1))
    const refresh = useUserSession().refresh()
    await vi.waitFor(() => expect(mocks.getSession).toHaveBeenCalledTimes(2))
    answerGuard({ data: session })
    const result = vi.fn()
    void Promise.resolve(navigation).then(result)
    await new Promise(resolve => setTimeout(resolve, 0))
    const returnedEarly = result.mock.calls.length > 0
    answerRefresh({ data: null })
    await refresh

    expect(returnedEarly).toBe(false)
    expect(await navigation).toEqual({ path: "/login", query: { redirect: "/private" } })
  })

  it.each([
    ["prerendered", { prerenderedAt: 1 }],
    ["cached", { isCached: true }],
  ])("reads the session while it hydrates a %s page", async (_, payload) => {
    mocks.state.value = session
    mocks.guardRoute.value = "/private"
    mocks.getSession.mockResolvedValue({ data: null })
    await setupBrowser("vitehub_session=1", payload, true)

    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })

    expect(mocks.getSession).toHaveBeenCalledTimes(1)
  })

  it("reads the session again for the login page of a redirect", async () => {
    mocks.getSession.mockResolvedValue({ data: null })
    await setupBrowser()
    const from = { ...userPage }

    expect(await mocks.middleware?.(from)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(await mocks.middleware?.({ ...guestPage, redirectedFrom: from })).toBeUndefined()

    expect(mocks.getSession).toHaveBeenCalledTimes(2)
  })

  it("ignores a late answer of a navigation that a newer navigation replaced", async () => {
    let answer: (value: unknown) => void = () => {}
    mocks.getSession.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    await setupBrowser()
    const from = { ...userPage }
    const late = mocks.middleware?.(from)

    // The visitor signs in and opens another user page before the first read answers.
    expect(await mocks.middleware?.({ path: "/account", fullPath: "/account", meta: { auth: "user" } })).toBeUndefined()
    answer({ data: null })

    expect(await late).toBeUndefined()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
    // A login page opened from the old navigation reads the session and sends the visitor away.
    expect(await mocks.middleware?.({ ...guestPage, redirectedFrom: from })).toBe("/")
    expect(mocks.getSession).toHaveBeenCalledTimes(3)
  })

  it("reads the session on each navigation, so Better Auth extends an active session", async () => {
    mocks.state.value = session
    await setupBrowser("vitehub_session=1")
    vi.useFakeTimers({ now: new Date("2026-12-01T00:00:00.000Z") })

    for (const day of [2, 3, 4]) {
      vi.setSystemTime(new Date(`2026-12-0${day}T00:00:00.000Z`))
      expect(await mocks.middleware?.(userPage)).toBeUndefined()
    }

    expect(mocks.getSession).toHaveBeenCalledTimes(3)
  })

  it("sees a sign-in when page scripts cannot read the session cookies", async () => {
    // With `advanced.cookies.session_token.attributes.path: "/api/auth"`, `document.cookie` on pages stays empty.
    mocks.state.value = null
    mocks.getSession.mockResolvedValue({ data: null })
    const app = await setupBrowser("", {}, true)
    expect(await mocks.middleware?.(guestPage)).toBeUndefined()
    app.isHydrating = false

    mocks.getSession.mockResolvedValue({ data: session })
    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(mocks.getSession).toHaveBeenCalledTimes(2)
  })

  it("sees a sign-out after hydration", async () => {
    mocks.state.value = session
    mocks.guardRoute.value = "/private"
    const app = await setupBrowser("vitehub_session=1", {}, true)
    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    app.isHydrating = false

    mocks.getSession.mockResolvedValue({ data: null })
    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
  })

  it("reads the session again after a failed read", async () => {
    mocks.getSession.mockResolvedValueOnce({ data: null, error: { status: 500 } })
    await setupBrowser("vitehub_session=1")

    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(await mocks.middleware?.(userPage)).toBeUndefined()

    expect(mocks.getSession).toHaveBeenCalledTimes(2)
  })

  it("keeps the redirectTo of a page", async () => {
    mocks.getSession.mockResolvedValue({ data: null })
    await setupBrowser()

    expect(await mocks.middleware?.({ path: "/team", fullPath: "/team", meta: { auth: { only: "user", redirectTo: "/join" } } })).toEqual({ path: "/join", query: { redirect: "/team" } })
  })

  it.each(["server", "browser"] as const)("keeps a signed-in visitor on a %s guest page that redirects to itself", async (host) => {
    mocks.state.value = session
    mocks.getSession.mockResolvedValue({ data: session })
    if (host === "browser") await setupBrowser("vitehub_session=1")
    else await plugin.setup({ payload: mocks.payload })

    expect(await mocks.middleware?.({ path: "/login", fullPath: "/login?tab=1", meta: { auth: { only: "guest", redirectTo: "/login" } } })).toBeUndefined()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })

  it.each([
    ["server", "/private", { only: "user", redirectTo: "/private" }],
    ["browser", "/private", { only: "user", redirectTo: "/private" }],
    ["browser", "/login/", "user"],
  ] as const)("denies a signed-out visitor a %s page %s whose sign-in page is itself", async (host, path, auth) => {
    mocks.state.value = null
    mocks.getSession.mockResolvedValue({ data: null })
    if (host === "browser") await setupBrowser()
    else await plugin.setup({ payload: mocks.payload })

    await mocks.middleware?.({ path, fullPath: `${path}?tab=1`, meta: { auth } })

    expect(mocks.navigateTo).not.toHaveBeenCalled()
    expect(mocks.showError).toHaveBeenCalledExactlyOnceWith({ statusCode: 401, statusMessage: "Signed out" })
  })

  it("redirects to a sign-in page that differs only by a trailing slash with strict routes", async () => {
    mocks.strictRoutes = true
    mocks.getSession.mockResolvedValue({ data: null })
    await setupBrowser()

    expect(await mocks.middleware?.({ path: "/login", fullPath: "/login", meta: { auth: { only: "user", redirectTo: "/login/" } } })).toEqual({ path: "/login/", query: { redirect: "/login" } })
    expect(mocks.showError).not.toHaveBeenCalled()
  })

  it("redirects a named navigation whose path would resolve to the public sign-in page", async () => {
    mocks.getSession.mockResolvedValue({ data: null })
    await setupBrowser()
    // Opened by name as `/:slug` with `slug: "LOGIN"`; resolving `/LOGIN` by path picks the public `/login` record.
    mocks.pages.set("/LOGIN", resolveRoute("/login").matched[0]!)
    const slugPage = { path: "/:slug" }

    expect(await mocks.middleware?.({ path: "/LOGIN", fullPath: "/LOGIN", matched: [slugPage], params: { slug: "LOGIN" }, meta: { auth: "user" } })).toEqual({ path: "/login", query: { redirect: "/LOGIN" } })
    expect(mocks.showError).not.toHaveBeenCalled()
  })

  it("keeps a signed-in visitor on a guest page whose params Vue Router gives in another form", async () => {
    mocks.state.value = session
    await setupBrowser("vitehub_session=1")
    // Resolving the path gives a repeatable param as an array, or leaves out an empty one; a named navigation gives a scalar, keys in another order, or `[]`.
    mocks.params.set("/welcome/start", { step: ["start"], team: "a" })
    const welcome = resolveRoute("/welcome/start").matched[0]!

    expect(await mocks.middleware?.({ path: "/welcome/start", fullPath: "/welcome/start?tab=details", matched: [welcome], params: { team: "a", step: "start" }, meta: { auth: { only: "guest", redirectTo: "/welcome/start" } } })).toBeUndefined()
    const welcomeIndex = resolveRoute("/welcome").matched[0]!
    expect(await mocks.middleware?.({ path: "/welcome", fullPath: "/welcome?tab=details", matched: [welcomeIndex], params: { step: [] }, meta: { auth: { only: "guest", redirectTo: "/welcome" } } })).toBeUndefined()
    expect(mocks.navigateTo).not.toHaveBeenCalled()
  })

  it("redirects a signed-in visitor from a guest page whose path also opens another page", async () => {
    mocks.state.value = session
    await setupBrowser("vitehub_session=1")
    // `/welcome/:step*` opened by name with `step: "start"`, while the path `/welcome/start` opens a static page.
    const steps = resolveRoute("/welcome").matched[0]!

    expect(await mocks.middleware?.({ path: "/welcome/start", fullPath: "/welcome/start", matched: [steps], params: { step: "start" }, meta: { auth: { only: "guest", redirectTo: "/welcome" } } })).toBe("/welcome")
    // `/docs/a//b` keeps its empty segment, so it is not `/docs/a/b`.
    mocks.params.set("/docs/a/b", { slug: ["a", "b"] })
    const docs = resolveRoute("/docs/a/b").matched[0]!
    expect(await mocks.middleware?.({ path: "/docs/a//b", fullPath: "/docs/a//b", matched: [docs], params: { slug: ["a", "", "b"] }, meta: { auth: { only: "guest", redirectTo: "/docs/a/b" } } })).toBe("/docs/a/b")
  })

  it("reads the session while it hydrates an error render that carries the decision", async () => {
    mocks.state.value = session
    await plugin.setup({ payload: mocks.payload })
    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    mocks.getSession.mockResolvedValue({ data: null })
    await setupBrowser("vitehub_session=1", { error: { status: 500 } }, true)

    expect(await mocks.middleware?.(userPage)).toEqual({ path: "/login", query: { redirect: "/private" } })
    expect(mocks.getSession).toHaveBeenCalledOnce()
  })

  it("keeps the browser from replaying a signed-in render whose decision hydration reuses", async () => {
    mocks.state.value = session
    await plugin.setup({ payload: mocks.payload })

    expect(await mocks.middleware?.(userPage)).toBeUndefined()

    expect(mocks.guardRoute.value).toBe("/private")
    expect(mocks.event.res.headers.get("cache-control")).toBe("private, no-store")
  })
})
