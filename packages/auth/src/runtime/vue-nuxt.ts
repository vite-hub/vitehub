// Nuxt provides this virtual module to applications that install the module.
// @ts-expect-error The package's standalone typecheck has no Nuxt virtual modules.
import { addRouteMiddleware, createError, defineNuxtPlugin, navigateTo, showError, tryUseNuxtApp, useRequestEvent, useRouter, useRuntimeConfig, useState } from "#app"

import { invariantError } from "@vite-hub/internal/invariant"
import { viteHubSessionMarkerCookie } from "@vite-hub/internal/runtime/page-tools-shared"

import { resolveAuthMountPath } from "../application-path.ts"
// The composables stay out of this plugin, so a page that uses no Auth composable and no Auth page guard does not
// download them. The plugin installs its hooks through the bridge, and the browser guard loads them on demand.
import { setDefaultAuthBasePath, setNuxtAppResolver, setNuxtErrorFactory, setRequestFetchResolver, setSessionSeedResolver, setSignOutHandler } from "../nuxt-bridge.ts"

import type { AuthPageGuardConfig, AuthPageMeta, AuthPageMode } from "../nuxt-types.ts"
import type { RequestFetch } from "../nuxt-bridge.ts"

type NuxtApp = {
  runWithContext<T>(run: () => T): T
  isHydrating?: boolean
  payload: { prerenderedAt?: unknown, isCached?: unknown, error?: unknown }
}
type RouteLike = { fullPath: string, matched: readonly object[], params: Record<string, unknown>, meta: { auth?: AuthPageMeta } }
type RouterLike = {
  currentRoute: { value: RouteLike }
  resolve(path: string): { matched: readonly object[], params: Record<string, unknown> }
}
/** Vue Router gives the same params in other forms: `"a"` or `["a"]`, `[]` or `""` or nothing for an empty one, and any key order. */
function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const values = (value: unknown) => JSON.stringify(value === undefined || value === "" ? [] : [value].flat())
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(key => values(a[key]) === values(b[key]))
}
type PageEvent = {
  url: URL
  req: Request & { ip?: string, runtime?: unknown, waitUntil?: unknown }
  res: { headers: Headers }
}

const stateKey = "vitehub:auth:session"
const guardRouteKey = "vitehub:auth:guard-route"

/**
 * True when the request may have a session: ViteHub's `vitehub_session` marker cookie, which Auth sets next to the
 * session cookie, or Better Auth's own `<prefix>.session_token` and `<prefix>.session_data` cookies.
 */
function hasSessionCookie(cookie: string | undefined): boolean {
  if (!cookie) return false
  const names = cookie.split(";").map(part => part.split("=")[0]?.trim() ?? "")
  return names.some(name => name === viteHubSessionMarkerCookie || /(?:^|\.)session_(?:token|data)$/.test(name))
}

const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/** Better Auth's client returns dates as `Date`. Revive them so the server's session has the same shape. */
function reviveDates(value: unknown): unknown {
  if (typeof value === "string" && isoDate.test(value)) return new Date(value)
  if (Array.isArray(value)) return value.map(reviveDates)
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, reviveDates(entry)]))
  return value
}

/** Forward Better Auth's `Set-Cookie` headers, such as a refreshed session, to the page response. */
function appendSetCookies(event: PageEvent, response: Response): void {
  for (const cookie of response.headers.getSetCookie()) event.res.headers.append("set-cookie", cookie)
}

const unforwardedHeaders = /^(?:accept|accept-encoding|connection|content-.+|expect|if-.+|keep-alive|proxy-.+|te|trailer|transfer-encoding|upgrade)$/

async function pageFetch(event: PageEvent, path: string, init?: RequestInit): Promise<Response> {
  if ((import.meta as ImportMeta & { client?: boolean }).client) throw invariantError("Auth page fetch runs only on the Nuxt server")
  const { serverFetch } = await import("nitro")
  const request = new Request(`${event.url.origin}${path}`, init)
  for (const [name, value] of event.req.headers) {
    if (!unforwardedHeaders.test(name) && !request.headers.has(name)) request.headers.set(name, value)
  }
  Object.assign(request, { ip: event.req.ip, runtime: event.req.runtime, waitUntil: event.req.waitUntil })
  return serverFetch(request)
}

/**
 * The path and query of a URL that Better Auth's client built. The client can build an absolute URL from a variable
 * such as `VERCEL_URL`, and that URL would leave the process.
 */
function pathOf(input: string | URL | Request): string {
  const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost")
  return url.pathname + url.search
}

function currentRequestFetch(): RequestFetch | undefined {
  const nuxtApp = tryUseNuxtApp() as object | undefined
  const event = nuxtApp ? useRequestEvent() as PageEvent | undefined : undefined
  if (!nuxtApp || !event) return undefined
  const requestFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const response = await pageFetch(event, pathOf(input), init)
    appendSetCookies(event, response)
    return response
  }
  return { request: nuxtApp, origin: event.url.origin, fetch: requestFetch }
}

/**
 * Reads the session of the request, so server rendering and hydration start signed in or signed out. Returns `null` at
 * once when the request has no session cookie, else a promise. Call it in a Nuxt context.
 */
function readServerSession(basePath: string): unknown {
  const event = useRequestEvent() as PageEvent | undefined
  if (!event) return undefined
  const cookie = event.req.headers.get("cookie") ?? undefined
  // Without a session cookie the request has no session. Skip the lookup, so signed-out pages do not load Better Auth.
  if (!hasSessionCookie(cookie)) return null
  return fetchServerSession(event, basePath)
}

async function fetchServerSession(event: PageEvent, basePath: string): Promise<unknown> {
  try {
    const response = await pageFetch(event, `${basePath}/get-session`)
    appendSetCookies(event, response)
    if (!response.ok) return undefined
    const data: unknown = await response.json()
    if (typeof data !== "object" || data === null) return null
    const session: unknown = Reflect.get(data, "session")
    const user: unknown = Reflect.get(data, "user")
    if (typeof session !== "object" || session === null || !user) return null
    // The page payload is readable by scripts on the page, so it never carries the session token.
    const { token: _token, ...safeSession } = session as Record<string, unknown>
    return reviveDates({ session: safeSession, user })
  }
  catch {
    // Unknown: the client reads the session itself.
    return undefined
  }
}

/** The session read of each server request, so the page guard and all components share one read. */
const serverReads = new WeakMap<object, () => unknown>()

// Typed `unknown` because the package build cannot see Nuxt's plugin type. Nuxt only reads the value.
const viteHubAuthPlugin: unknown = defineNuxtPlugin({
  name: "vitehub:auth",
  enforce: "pre",
  setup(nuxtApp: NuxtApp) {
    setNuxtAppResolver(() => tryUseNuxtApp() as NuxtApp | undefined)
    setNuxtErrorFactory(createError)
    // During server rendering, client calls such as `listSessions()` reach the app in-process with the visitor's cookie.
    if (!("window" in globalThis)) setRequestFetchResolver(currentRequestFetch)
    const runtimeConfig = useRuntimeConfig() as { app?: { baseURL?: string }, public?: { vitehubAuth?: false | Partial<AuthPageGuardConfig> } }
    const config = runtimeConfig.public?.vitehubAuth
    const signInPage = config ? config.signInPage : "/login"
    const afterSignIn = (config || undefined)?.afterSignIn ?? "/"
    const routeModes = new WeakMap<RouteLike, AuthPageMode>()
    /** The page guard of `to`: where a visitor goes, or nothing when the page has no guard. */
    const guardOf = (to: RouteLike, meta = to.meta.auth) => {
      if (config === false || meta === undefined || meta === false) return
      const mode = typeof meta === "string" ? meta : meta === true ? "user" : meta.only ?? "user"
      const redirectTo = typeof meta === "object" ? meta.redirectTo : undefined
      // A redirect to the page itself would loop. Ask Vue Router, which knows `strict` and `sensitive`, and compare with the record and params it chose for `to`.
      const isThisPage = (target: string) => {
        const page = (useRouter() as RouterLike).resolve(target)
        return page.matched.length > 0 && page.matched.at(-1) === to.matched.at(-1) && sameParams(page.params, to.params)
      }
      return (loggedIn: boolean, signedOut = false) => {
        if (mode === "guest") return loggedIn && !isThisPage(redirectTo ?? afterSignIn) ? navigateTo(redirectTo ?? afterSignIn) : undefined
        if (loggedIn) return
        const signInTarget = redirectTo ?? signInPage
        // A page that is its own sign-in page stays closed to a signed-out visitor.
        if (signInTarget && isThisPage(signInTarget)) return showError({ statusCode: 401, statusMessage: "Signed out" })
        if (redirectTo || signInPage !== null) return navigateTo({ path: redirectTo ?? signInPage ?? "/login", query: { redirect: to.fullPath } })
        if (signedOut) return showError({ statusCode: 401, statusMessage: "Signed out" })
        // The Auth route starts the provider sign-in and comes back to `?redirect=`, a path below `app.baseURL`.
        const signIn = `${resolveAuthMountPath(config?.basePath ?? "/api/auth", runtimeConfig.app?.baseURL)}/sign-in`
        return navigateTo(`${signIn}?${new URLSearchParams({ redirect: to.fullPath })}`, { external: true })
      }
    }
    if ("window" in globalThis) {
      setSignOutHandler(redirectTo => nuxtApp.runWithContext(() => {
        // A component that starts after the sign-out must not start with the session that the server read.
        const seed = useState(stateKey, () => undefined) as { value: unknown }
        seed.value = null
        // Nuxt throws for a URL on another site without `external`.
        if (redirectTo) return navigateTo(redirectTo, { external: /^(?:[\w+.-]{2,}:|[/\\]{2})/.test(redirectTo) })
        // The guard runs only when the route changes, so do its work for the page on screen.
        const route = (useRouter() as RouterLike).currentRoute.value
        return guardOf(route, route.meta.auth ?? routeModes.get(route))?.(false, true)
      }))
    }
    if (config === false) return
    // The server reads the session in process, where Nitro serves Auth below the base path of the build. The browser
    // calls Auth below the `app.baseURL` of the page, which `NUXT_APP_BASE_URL` can set at runtime.
    const basePath = resolveAuthMountPath(config?.basePath ?? "/api/auth", "window" in globalThis ? runtimeConfig.app?.baseURL : undefined)
    // The page guard and the auto-imported composables share the default client, with the plugins of the app's
    // `auth.client.ts`. They call the same Auth path, and a read of the guard updates every component.
    setDefaultAuthBasePath(basePath)
    // The server reads the session the first time that a page guard or a component needs it, and puts it in the
    // payload. A page that uses neither does no lookup. Returns the session, or a promise of it while the read runs.
    let serverSession: (() => unknown) | undefined
    if (!("window" in globalThis)) {
      let read = false
      let session: unknown
      serverSession = () => {
        if (read) return session
        read = true
        const seed = useState(stateKey) as { value: unknown }
        session = seed.value !== undefined ? seed.value : readServerSession(basePath)
        if (session instanceof Promise) session = session.then(value => (session = seed.value = value))
        else seed.value = session
        return session
      }
      serverReads.set(nuxtApp, serverSession)
    }
    // A prerendered or cached page was rendered without this visitor's cookie, so its session is unknown.
    const stale = "window" in globalThis && Boolean(nuxtApp.payload.prerenderedAt || nuxtApp.payload.isCached)
    // On the server, one resolver serves all requests. It finds the read of the request through the request's Nuxt app.
    setSessionSeedResolver((read) => {
      if (stale) return undefined
      // Read the state directly: on the server, `runWithContext()` returns a Promise even for a sync callback.
      // Outside a Nuxt context, such as module scope, the session is unknown.
      try {
        const app = read ? tryUseNuxtApp() as NuxtApp | undefined : undefined
        const readRequest = app && serverReads.get(app)
        return readRequest ? readRequest() : (useState(stateKey) as { value: unknown }).value
      }
      catch {
        return undefined
      }
    })

    // Counts navigations, so a read can tell that a newer navigation started while Better Auth answered.
    let navigations = 0

    const guard = (to: RouteLike, meta: AuthPageMeta | undefined, navigation: number) => {
      const decide = guardOf(to, meta)
      if (!decide) return
      const page = to.fullPath.split("#", 1)[0]
      // An error render can replace the response's Cache-Control, so the browser may have kept it.
      if (navigation === 1 && !serverSession && !stale && !nuxtApp.payload.error && nuxtApp.isHydrating && useState(guardRouteKey).value === page) return decide(true)
      const decideAndSeed = (loggedIn: boolean) => {
        if (serverSession && loggedIn) {
          useState(guardRouteKey).value = page
          // Hydration trusts this decision, so the browser must not replay the page from its cache after a sign-out.
          ;(useRequestEvent() as PageEvent | undefined)?.res.headers.set("cache-control", "private, no-store")
        }
        return decide(loggedIn)
      }
      // Decide synchronously on the server when the session is known, to keep Nuxt's request context. Browser
      // navigations read the session into the state that `useUserSession()` and `useAbility()` share, so the page and
      // the guard see the same answer.
      const session = serverSession?.()
      // Keep the Nuxt app for the session read and the navigation after it answers.
      const app = tryUseNuxtApp() as NuxtApp | undefined
      const inApp = <T>(run: () => T): T => app ? app.runWithContext(run) : run()
      const loggedIn = !serverSession
        // A query, even an empty one, gives the navigation a read of its own instead of a replaced navigation's read.
        // SAFETY: `refresh` is the session store's `read()`, which takes the query of Better Auth's `getSession()`.
        ? import("../vue.ts").then(({ useUserSession }) => inApp(() => (useUserSession().refresh as (query: object) => Promise<{ session?: unknown, user?: unknown } | null>)({})))
            .then(current => Boolean(current?.session && current?.user))
        : session instanceof Promise ? session.then(Boolean) : Boolean(session)
      if (typeof loggedIn === "boolean") return decideAndSeed(loggedIn)
      return loggedIn.then((value) => {
        // Only the latest navigation decides. Vue Router cancels a navigation that a newer one replaced, but it still
        // follows a redirect that the old navigation returns, so an old answer could open a page that is now wrong.
        if (navigation !== navigations) return
        return inApp(() => decideAndSeed(value))
      })
    }
    // Nuxt runs this global middleware before the named ones of a route, so it counts each navigation once.
    addRouteMiddleware("vitehub-auth", (to: RouteLike) => guard(to, to.meta.auth, ++navigations), { global: true })
    // `definePageMeta({ auth })` wins over the named guards that `access.pages` attaches.
    for (const mode of ["user", "guest"] as const) {
      addRouteMiddleware(`vitehub-auth-${mode}`, (to: RouteLike) => {
        if (to.meta.auth !== undefined) return
        // Keep the policy on this route, so an aborted navigation cannot replace the page's sign-out guard.
        routeModes.set(to, mode)
        return guard(to, mode, navigations)
      })
    }
  },
})

export default viteHubAuthPlugin
