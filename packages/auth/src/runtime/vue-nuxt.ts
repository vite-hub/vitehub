// Nuxt provides this virtual module to applications that install the module.
// @ts-expect-error The package's standalone typecheck has no Nuxt virtual modules.
import { addRouteMiddleware, createError, defineNuxtPlugin, navigateTo, showError, tryUseNuxtApp, useRequestEvent, useRouter, useRuntimeConfig, useState } from "#app"

import { invariantError } from "@vite-hub/internal/invariant"
import { viteHubSessionMarkerCookie } from "@vite-hub/internal/runtime/page-tools-shared"

import { resolveAuthMountPath } from "../application-path.ts"
// The composables stay out of this plugin, so a page that uses no Auth composable and no Auth page guard does not
// download them. The plugin installs its hooks through the bridge, and the browser guard loads them on demand.
import { setDefaultAuthBasePath, setNuxtAppResolver, setNuxtErrorFactory, setRequestFetchResolver, setSessionSeedResolver, setSignOutHandler } from "../nuxt-bridge.ts"

import type { AuthPageGuardConfig, AuthPageMeta } from "../nuxt-types.ts"
import type { RequestFetch } from "../nuxt-bridge.ts"

type NuxtApp = {
  runWithContext<T>(run: () => T): T
  payload: { prerenderedAt?: unknown, isCached?: unknown }
}
type RouteLike = { fullPath: string, meta: { auth?: AuthPageMeta } }
/** The H3 event of a page request on the server. */
type PageEvent = {
  url: URL
  req: Request & { ip?: string, runtime?: unknown, waitUntil?: unknown }
  res: { headers: Headers }
}

const stateKey = "vitehub:auth:session"

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

// Headers of the page request that do not apply to the in-process request, as in Nuxt's `useRequestFetch()`.
const unforwardedHeaders = /^(?:accept|accept-encoding|connection|content-.+|expect|if-.+|keep-alive|proxy-.+|te|trailer|transfer-encoding|upgrade)$/

/**
 * Calls the app in-process at the origin of the page request, with its headers, so Auth resolves the same origin and
 * Better Auth reads the same cookie names, such as `__Secure-better-auth.session_token` on https.
 */
async function pageFetch(event: PageEvent, path: string, init?: RequestInit): Promise<Response> {
  if ((import.meta as ImportMeta & { client?: boolean }).client) throw invariantError("Auth page fetch runs only on the Nuxt server")
  const { serverFetch } = await import("nitro")
  // Concatenate: a path such as `//host/x` must stay a path of the page's origin.
  const request = new Request(`${event.url.origin}${path}`, init)
  for (const [name, value] of event.req.headers) {
    if (!unforwardedHeaders.test(name) && !request.headers.has(name)) request.headers.set(name, value)
  }
  // As H3's `fetchWithEvent()`: keep the client address for the rate limit and the Cloudflare bindings.
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

/** The fetch of the current page request for Better Auth's client, or `undefined` outside a request. */
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

/** Asks Better Auth for the session of the page request. */
async function fetchServerSession(event: PageEvent, basePath: string): Promise<unknown> {
  try {
    // Nitro serves Auth below the base path of the build, which `basePath` has. A runtime `app.baseURL`, such as one
    // from `NUXT_APP_BASE_URL`, must not be added: the request would render a page that reads the session again.
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
    /** The page guard of `to`: where a visitor goes, or nothing when the page has no guard. */
    const guardOf = (to: RouteLike) => {
      const meta = to.meta.auth
      if (config === false || meta === undefined || meta === false) return
      const mode = typeof meta === "string" ? meta : meta === true ? "user" : meta.only ?? "user"
      const redirectTo = typeof meta === "object" ? meta.redirectTo : undefined
      return (loggedIn: boolean, signedOut = false) => {
        if (mode === "guest") return loggedIn ? navigateTo(redirectTo ?? afterSignIn) : undefined
        if (loggedIn) return
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
        return guardOf((useRouter() as { currentRoute: { value: RouteLike } }).currentRoute.value)?.(false, true)
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

    addRouteMiddleware("vitehub-auth", (to: RouteLike) => {
      const decide = guardOf(to)
      if (!decide) return
      // Decide synchronously on the server when the session is known, to keep Nuxt's request context. Browser
      // navigations read the session into the state that `useUserSession()` and `useAbility()` share, so the page and
      // the guard see the same answer.
      const session = serverSession?.()
      // Keep the Nuxt app for the session read and the navigation after it answers.
      const app = tryUseNuxtApp() as NuxtApp | undefined
      const inApp = <T>(run: () => T): T => app ? app.runWithContext(run) : run()
      const loggedIn = !serverSession
        ? import("../vue.ts").then(({ useUserSession }) => inApp(() => useUserSession().refresh())).then(current => Boolean(current?.session && current?.user))
        : session instanceof Promise ? session.then(Boolean) : Boolean(session)
      if (typeof loggedIn === "boolean") return decide(loggedIn)
      return loggedIn.then(value => inApp(() => decide(value)))
    }, { global: true })
  },
})

export default viteHubAuthPlugin
