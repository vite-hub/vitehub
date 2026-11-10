// Nuxt provides this virtual module to applications that install the module.
// @ts-expect-error The package's standalone typecheck has no Nuxt virtual modules.
import { addRouteMiddleware, defineNuxtPlugin, navigateTo, tryUseNuxtApp, useRequestEvent, useRequestFetch, useRuntimeConfig, useState } from "#app"

import { viteHubSessionMarkerCookie } from "@vite-hub/internal/runtime/page-tools-shared"

import { resolveAuthMountPath } from "../application-path.ts"
import { createAuthClient, setNuxtAppResolver, setSessionSeedResolver } from "../vue.ts"

import type { AuthPageMeta, AuthRedirects } from "../nuxt-types.ts"

type NuxtApp = {
  runWithContext<T>(run: () => T): T
  payload: { prerenderedAt?: unknown, isCached?: unknown }
}
type RouteLike = { path: string, fullPath: string, meta: { auth?: AuthPageMeta } }
type ResponseLike = { headers: Headers }
type EventLike = { node?: { res?: { appendHeader?: (name: string, value: string) => void } }, res?: { headers?: Headers } }

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

/** When a session ends, in milliseconds, from Better Auth's `session.expiresAt`. `Infinity` without a valid date. */
function sessionEnd(data: unknown): number {
  const session: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "session") : undefined
  const expiresAt: unknown = typeof session === "object" && session !== null ? Reflect.get(session, "expiresAt") : undefined
  const time = expiresAt instanceof Date || typeof expiresAt === "string" || typeof expiresAt === "number" ? new Date(expiresAt).getTime() : Number.NaN
  return Number.isNaN(time) ? Infinity : time
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
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    if (event.res?.headers) event.res.headers.append("set-cookie", cookie)
    else event.node?.res?.appendHeader?.("set-cookie", cookie)
  }
}

/** Reads the session of the request once, so server rendering and hydration start signed in or signed out. */
async function readServerSession(basePath: string): Promise<unknown> {
  const event = useRequestEvent() as (EventLike & { req?: { headers?: Headers }, headers?: Headers, node?: { req?: { headers?: Record<string, string | string[] | undefined> } } }) | undefined
  if (!event) return undefined
  // H3 2 (Nuxt 5) keeps the request on `event.req`. H3 1 exposes `event.headers` and the Node request.
  const cookie = event.req?.headers?.get("cookie") ?? event.headers?.get("cookie") ?? [event.node?.req?.headers?.cookie].flat().join("; ")
  // Without a session cookie the request has no session. Skip the lookup, so signed-out pages do not load Better Auth.
  if (!hasSessionCookie(cookie)) return null
  try {
    const data: unknown = await useRequestFetch()(`${basePath}/get-session`, {
      onResponse: ({ response }: { response: ResponseLike }) => appendSetCookies(event, response),
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

// Typed `unknown` because the package build cannot see Nuxt's plugin type. Nuxt only reads the value.
const viteHubAuthPlugin: unknown = defineNuxtPlugin({
  name: "vitehub:auth",
  enforce: "pre",
  async setup(nuxtApp: NuxtApp) {
    setNuxtAppResolver(() => tryUseNuxtApp() as NuxtApp | undefined)
    const config = useRuntimeConfig().public?.vitehubAuth as false | { basePath?: string, redirects?: AuthRedirects } | undefined
    if (config === false) return
    const basePath = resolveAuthMountPath(config?.basePath ?? "/api/auth")
    const client = createAuthClient({ basePath })
    const redirects = config?.redirects ?? {}
    const seed = useState(stateKey, () => undefined) as { value: unknown }
    if (!("window" in globalThis) && seed.value === undefined) seed.value = await readServerSession(basePath)
    // A prerendered or cached page was rendered without this visitor's cookie, so its session is unknown.
    const stale = "window" in globalThis && Boolean(nuxtApp.payload.prerenderedAt || nuxtApp.payload.isCached)
    setSessionSeedResolver(() => {
      if (stale) return undefined
      // Read the state directly: on Nuxt 5, `runWithContext()` returns a Promise even for a sync callback.
      // Outside a Nuxt context, such as module scope, the session is unknown.
      try {
        return (useState(stateKey, () => undefined) as { value: unknown }).value
      }
      catch {
        return undefined
      }
    })

    // In the browser, whether the visitor has a session: the server's answer, then the last read. `undefined` is unknown.
    // A known session counts only until its `expiresAt`, because an expired session can keep its cookies.
    let known: boolean | undefined = stale || seed.value === undefined ? undefined : Boolean(seed.value)
    let knownUntil = sessionEnd(seed.value)

    addRouteMiddleware("vitehub-auth", (to: RouteLike) => {
      const meta = to.meta.auth
      if (meta === undefined || meta === false) return
      const mode = typeof meta === "string" ? meta : meta === true ? "user" : meta.only ?? "user"
      const redirectTo = typeof meta === "object" ? meta.redirectTo : undefined
      const decide = (loggedIn: boolean) => {
        const target = mode === "guest" ? loggedIn && (redirectTo ?? redirects.guest ?? "/") : !loggedIn && (redirectTo ?? redirects.login ?? "/login")
        // A redirect to the page itself would loop: the guard of that page sends the visitor away again.
        if (!target || target.split(/[?#]/)[0] === to.path) return
        return navigateTo(mode === "guest" ? target : { path: target, query: { redirect: to.fullPath } })
      }
      // Decide synchronously on the server to keep Nuxt's request context.
      if (!("window" in globalThis)) return decide(Boolean(seed.value))
      // The marker cookie appears on sign-in and goes on sign-out, also in other tabs. While it agrees with the known
      // session, decide without a request. Otherwise read the session directly, without a composable's watchers.
      if (known !== undefined && Date.now() < knownUntil && known === hasSessionCookie((globalThis as { document?: { cookie?: string } }).document?.cookie)) return decide(known)
      const loggedIn = client.getSession().then((result) => {
        const value = Boolean(result.data?.session && result.data?.user)
        // After a failed read the session stays unknown, so the next navigation reads it again.
        known = result.error ? undefined : value
        knownUntil = sessionEnd(result.data)
        return value
      })
      // In the browser, keep the Nuxt app for the navigation after Better Auth answers.
      const app = tryUseNuxtApp() as NuxtApp | undefined
      return loggedIn.then(value => app ? app.runWithContext(() => decide(value)) : decide(value))
    }, { global: true })
    return { provide: { vitehubAuthClient: client } }
  },
})

export default viteHubAuthPlugin
