// Nuxt provides this virtual module to applications that install the module.
// @ts-expect-error The package's standalone typecheck has no Nuxt virtual modules.
import { addRouteMiddleware, createError, defineNuxtPlugin, navigateTo, tryUseNuxtApp, useRequestEvent, useRequestFetch, useRuntimeConfig, useState } from "#app"

import { viteHubSessionMarkerCookie } from "@vite-hub/internal/runtime/page-tools-shared"

import { resolveAuthMountPath } from "../application-path.ts"
import { createAuthClient, setNuxtAppResolver, setNuxtErrorFactory, setSessionSeedResolver } from "../vue.ts"

import type { AuthPageMeta, AuthRedirects } from "../nuxt-types.ts"

type NuxtApp = {
  runWithContext<T>(run: () => T): T
  payload: { prerenderedAt?: unknown, isCached?: unknown }
}
type RouteLike = { fullPath: string, meta: { auth?: AuthPageMeta } }
type ResponseLike = { headers: Headers }
type EventLike = { req?: { headers?: Headers }, res?: { headers?: Headers } }

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
function appendSetCookies(event: EventLike, response: ResponseLike): void {
  for (const cookie of response.headers.getSetCookie?.() ?? []) event.res?.headers?.append("set-cookie", cookie)
}

/**
 * Reads the session of the request, so server rendering and hydration start signed in or signed out. Returns `null` at
 * once when the request has no session cookie, else a promise. Call it in a Nuxt context.
 */
function readServerSession(basePath: string): unknown {
  const event = useRequestEvent() as EventLike | undefined
  if (!event) return undefined
  const cookie = event.req?.headers?.get("cookie") ?? undefined
  // Without a session cookie the request has no session. Skip the lookup, so signed-out pages do not load Better Auth.
  if (!hasSessionCookie(cookie)) return null
  return fetchServerSession(event, useRequestFetch(), basePath)
}

/** Asks Better Auth for the session with Nuxt's request fetch, which the caller got in a Nuxt context. */
async function fetchServerSession(event: EventLike, fetch: (path: string, options: { onResponse: (context: { response: ResponseLike }) => void }) => Promise<unknown>, basePath: string): Promise<unknown> {
  try {
    const data: unknown = await fetch(`${basePath}/get-session`, {
      onResponse: ({ response }) => appendSetCookies(event, response),
    })
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
    const config = useRuntimeConfig().public?.vitehubAuth as false | { basePath?: string, redirects?: AuthRedirects } | undefined
    if (config === false) return
    const basePath = resolveAuthMountPath(config?.basePath ?? "/api/auth")
    const client = createAuthClient({ basePath })
    const redirects = config?.redirects ?? {}
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
      // Read the state directly: on Nuxt 5, `runWithContext()` returns a Promise even for a sync callback.
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
      const meta = to.meta.auth
      if (meta === undefined || meta === false) return
      const mode = typeof meta === "string" ? meta : meta === true ? "user" : meta.only ?? "user"
      const redirectTo = typeof meta === "object" ? meta.redirectTo : undefined
      const decide = (loggedIn: boolean) => {
        if (mode === "guest") return loggedIn ? navigateTo(redirectTo ?? redirects.guest ?? "/") : undefined
        if (!loggedIn) return navigateTo({ path: redirectTo ?? redirects.login ?? "/login", query: { redirect: to.fullPath } })
      }
      // Decide synchronously on the server when the session is known, to keep Nuxt's request context. Browser
      // navigations read the current session directly, without installing a composable's watchers outside a component scope.
      const session = serverSession?.()
      const loggedIn = !serverSession
        ? client.getSession().then(result => Boolean(result.data?.session && result.data?.user))
        : session instanceof Promise ? session.then(Boolean) : Boolean(session)
      if (typeof loggedIn === "boolean") return decide(loggedIn)
      // Keep the Nuxt app for the navigation after the session read answers.
      const app = tryUseNuxtApp() as NuxtApp | undefined
      return loggedIn.then(value => app ? app.runWithContext(() => decide(value)) : decide(value))
    }, { global: true })
    return { provide: { vitehubAuthClient: client } }
  },
})

export default viteHubAuthPlugin
