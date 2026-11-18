// The hooks that the Nuxt plugin installs for the Vue composables. Its own module, so the plugin sets them without
// loading the composables: a page that uses no Auth composable and no Auth page guard does not download them.
import type { AbilityErrorData } from "./ability-error.ts"

/** The members of the Nuxt app that the composables read. */
export type AuthNuxtApp = { runWithContext<T>(run: () => T): T, isHydrating?: boolean, $vitehubAuthClient?: unknown }

/** What `authorize()` passes to Nuxt's `createError()`: the refusal, as the server sends it, and `fatal`. */
export type AuthNuxtErrorInput = { status: number, statusText: string, message: string, data: AbilityErrorData, fatal: true }

/** The fetch of one server request, which Better Auth's client uses for the calls of that request. */
export interface RequestFetch {
  /** The same object for every call of one request, such as the Nuxt app of the request. */
  request: object
  /** The origin of the request. On the server, Better Auth's client needs an absolute URL. */
  origin: string
  /** Calls the app in-process with the headers of the request, such as the cookie. */
  fetch: typeof fetch
}

interface AuthNuxtBridge {
  nuxtAppResolver?: () => AuthNuxtApp | undefined
  nuxtErrorFactory?: (input: AuthNuxtErrorInput) => Error
  sessionSeedResolver?: (read: boolean) => unknown
  signOutHandler?: (redirectTo: string | undefined) => unknown
  defaultBasePath?: string
  requestFetchResolver?: () => RequestFetch | undefined
}

/** The hooks that the setters below install. The composables read them. */
export const authNuxtBridge: AuthNuxtBridge = {}

/** Internal bridge installed by the Nuxt module, without making `#app` a dependency of the Vue entry. */
export function setNuxtAppResolver(resolver: (() => AuthNuxtApp | undefined) | undefined): void {
  authNuxtBridge.nuxtAppResolver = resolver
}

/** Internal bridge installed by the Nuxt module: Nuxt's `createError()`, so a refusal of `authorize()` shows the error page. */
export function setNuxtErrorFactory(factory: ((input: AuthNuxtErrorInput) => Error) | undefined): void {
  authNuxtBridge.nuxtErrorFactory = factory
}

/**
 * Internal bridge installed by the Nuxt module in the browser. `signOut()` of `useUserSession()` calls it after a
 * sign-out. It forgets the session that the server read, and opens `redirectTo`, or the login page when the page on
 * screen is only for signed-in visitors.
 */
export function setSignOutHandler(handler: ((redirectTo: string | undefined) => unknown) | undefined): void {
  authNuxtBridge.signOutHandler = handler
}

/**
 * Internal bridge installed by the Nuxt module: the path of Better Auth for the default `authClient`, such as
 * `/app/auth` for `defineAuth({ basePath: '/auth' })` below Nuxt `app.baseURL` `/app/`. The client reads it when it
 * loads Better Auth. Without it, the client uses `/api/auth` below the base path of the build.
 */
export function setDefaultAuthBasePath(path: string | undefined): void {
  authNuxtBridge.defaultBasePath = path
}

/**
 * Internal bridge installed by the Nuxt module. The resolver returns the session that the server read for this
 * request, `null` when the request had none, or `undefined` when nobody knows yet, such as on a prerendered page.
 * With `read` on the server, it reads the session if the request did not read it yet, and can return a promise of it.
 */
export function setSessionSeedResolver(resolver: ((read: boolean) => unknown) | undefined): void {
  authNuxtBridge.sessionSeedResolver = resolver
}

/**
 * Internal bridge installed by the Nuxt module. On the server, the resolver returns the fetch of the current request, or
 * `undefined` outside a request.
 */
export function setRequestFetchResolver(resolver: (() => RequestFetch | undefined) | undefined): void {
  authNuxtBridge.requestFetchResolver = resolver
}
