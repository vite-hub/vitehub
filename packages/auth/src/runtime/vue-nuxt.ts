// Nuxt provides this virtual module to applications that install the module.
// @ts-expect-error The package's standalone typecheck has no Nuxt virtual modules.
import { addRouteMiddleware, defineNuxtPlugin, navigateTo, tryUseNuxtApp, useRequestEvent, useRequestFetch, useRuntimeConfig, useState } from "#app"

import { resolveAuthMountPath } from "../application-path.ts"
import { authClient, loadAuthClient, setNuxtAppResolver, setSessionSeedResolver, useUserSession } from "../vue.ts"

import type { AuthPageMeta, AuthRedirects } from "../nuxt-types.ts"

type NuxtApp = {
  runWithContext<T>(run: () => T): T
  payload: { prerenderedAt?: unknown, isCached?: unknown }
}
type RouteLike = { fullPath: string, meta: { auth?: AuthPageMeta } }
type ResponseLike = { headers: Headers }
type EventLike = { node?: { res?: { appendHeader?: (name: string, value: string) => void } }, res?: { headers?: Headers } }

const stateKey = "vitehub:auth:session"

/** Better Auth names its session cookie `<prefix>.session_token`, and keeps a cached copy in `<prefix>.session_data`. */
function hasSessionCookie(cookie: string | undefined): boolean {
  return Boolean(cookie && /(?:^|;\s*)[^=;]*(?:session_token|session_data)=/.test(cookie))
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
async function readServerSession(): Promise<unknown> {
  const event = useRequestEvent() as (EventLike & { headers?: Headers, node?: { req?: { headers?: Record<string, string | string[] | undefined> } } }) | undefined
  if (!event) return undefined
  const cookie = event.headers?.get("cookie") ?? [event.node?.req?.headers?.cookie].flat().join("; ")
  // Without a session cookie the request has no session. Skip the lookup, so signed-out pages do not load Better Auth.
  if (!hasSessionCookie(cookie)) return null
  try {
    const data: unknown = await useRequestFetch()(`${resolveAuthMountPath("/api/auth")}/get-session`, {
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

/** True when a session exists. Uses the server's answer during server rendering and asks Better Auth in the browser. */
async function signedIn(): Promise<boolean> {
  const { loggedIn } = useUserSession()
  if (loggedIn.value) return true
  if (!("window" in globalThis)) return false
  const client = await loadAuthClient(authClient)
  const result = await client.getSession()
  return Boolean(result.data?.session)
}

export default defineNuxtPlugin({
  name: "vitehub:auth",
  enforce: "pre",
  async setup(nuxtApp: NuxtApp) {
    setNuxtAppResolver(() => tryUseNuxtApp() as NuxtApp | undefined)
    const seed = useState(stateKey, () => undefined) as { value: unknown }
    if (!("window" in globalThis) && seed.value === undefined) seed.value = await readServerSession()
    // A prerendered or cached page was rendered without this visitor's cookie, so its session is unknown.
    const stale = "window" in globalThis && Boolean(nuxtApp.payload.prerenderedAt || nuxtApp.payload.isCached)
    setSessionSeedResolver(() => {
      if (stale) return undefined
      const app = tryUseNuxtApp() as NuxtApp | undefined
      return app ? app.runWithContext(() => (useState(stateKey, () => undefined) as { value: unknown }).value) : undefined
    })

    const redirects: AuthRedirects = useRuntimeConfig().public?.vitehubAuth?.redirects ?? {}
    addRouteMiddleware("vitehub-auth", async (to: RouteLike) => {
      const meta = to.meta.auth
      if (meta === undefined || meta === false) return
      const mode = typeof meta === "string" ? meta : meta === true ? "user" : meta.only ?? "user"
      const redirectTo = typeof meta === "object" ? meta.redirectTo : undefined
      const loggedIn = await signedIn()
      if (mode === "guest") return loggedIn ? navigateTo(redirectTo ?? redirects.guest ?? "/") : undefined
      if (!loggedIn) return navigateTo({ path: redirectTo ?? redirects.login ?? "/login", query: { redirect: to.fullPath } })
    }, { global: true })
  },
})
