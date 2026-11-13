import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSSRApp, defineComponent, h, ref, watch } from "vue"
import { renderToString } from "vue/server-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import hubAuthNuxt from "../src/nuxt.ts"
import { Can, useUserSession } from "../src/vue.ts"

import type { AuthPageMeta } from "../src/nuxt-types.ts"
import type { createAuthClient } from "../src/vue.ts"

type Route = { path: string, fullPath: string, redirectedFrom?: object, meta: { auth?: AuthPageMeta } }
type Middleware = (route: Route) => unknown
type App = { runWithContext: <T>(run: () => T) => T, isHydrating?: boolean, payload: { prerenderedAt?: number, isCached?: boolean }, $vitehubAuthClient?: unknown }
type PublicConfig = { vitehubAuth?: false | { basePath?: string, redirects?: { login: string, guest: string } } }

const mocks = vi.hoisted(() => ({
  config: {} as { public?: PublicConfig },
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
  middleware: undefined as Middleware | undefined,
}))

vi.mock("#app", () => ({
  createError: mocks.createError,
  defineNuxtPlugin: (plugin: unknown) => plugin,
  addRouteMiddleware: (_name: string, middleware: Middleware) => { mocks.middleware = middleware },
  navigateTo: mocks.navigateTo,
  tryUseNuxtApp: () => mocks.app,
  useRequestEvent: () => mocks.event,
  useRequestFetch: () => mocks.requestFetch,
  useRuntimeConfig: () => mocks.config,
  useState: () => mocks.state,
}))

vi.mock("#vitehub/auth/abilities", () => import("./fixtures/abilities.ts"))

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
  default: { setup: (app: { isHydrating?: boolean, payload: App["payload"] }) => { provide: { vitehubAuthClient: ReturnType<typeof createAuthClient> } } | undefined }
}
const roots: string[] = []
const session = { session: { id: "s", token: "secret", expiresAt: "2027-01-01T00:00:00.000Z" }, user: { id: "u" } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.config = { public: { vitehubAuth: { redirects: { login: "/login", guest: "/" } } } }
  mocks.state = { value: undefined }
  mocks.event = { req: { headers: new Headers({ cookie: "vitehub_session=1" }) }, res: { headers: new Headers() } }
  mocks.payload = {}
  mocks.app = { runWithContext: run => run(), payload: mocks.payload }
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
    expect(mocks.middleware?.(guestPage)).toBe("/")
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

  it("reads the session from the configured client endpoint without session watchers", async () => {
    await configure("/auth", "/app/")
    await setupBrowser("vitehub_session=1")

    expect(await mocks.middleware?.(userPage)).toBeUndefined()

    expect(mocks.createAuthClient).toHaveBeenCalledWith({ basePath: "/app/auth" })
    expect(mocks.useSession).not.toHaveBeenCalled()
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
  })

  it("decides the hydration of a page from the session that the server read", async () => {
    mocks.state.value = session
    await setupBrowser("vitehub_session=1", {}, true)

    expect(await mocks.middleware?.(userPage)).toBeUndefined()
    expect(await mocks.middleware?.(guestPage)).toBe("/")

    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(mocks.createAuthClient).not.toHaveBeenCalled()
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
  ])("reads the session while it hydrates a %s page", async (_, payload) => {
    mocks.state.value = null
    await setupBrowser("vitehub_session=1", payload, true)

    expect(await mocks.middleware?.(userPage)).toBeUndefined()

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
    expect(mocks.getSession).toHaveBeenCalledTimes(1)
  })

  it("sees a sign-out after hydration", async () => {
    mocks.state.value = session
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
