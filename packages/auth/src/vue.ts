import { computed, getCurrentInstance, getCurrentScope, shallowRef, watch } from "vue"

import { resolveAuthMountPath } from "./application-path.ts"

import type { BetterAuthClientOptions, SessionQueryParams } from "better-auth"
import type { createAuthClient as createBetterAuthClient, BetterFetchError, VueAuthClient } from "better-auth/vue"
import type { ComputedRef, DeepReadonly, EffectScope, Ref } from "vue"

export type { VueAuthClient } from "better-auth/vue"

const LOAD = Symbol.for("vitehub.auth.client.load")

type Callable = (...args: unknown[]) => unknown
type NuxtApp = { runWithContext<T>(run: () => T): T }

let nuxtAppResolver: (() => NuxtApp | undefined) | undefined

/** Internal bridge installed by the Nuxt module, without making `#app` a dependency of this entry. */
export function setNuxtAppResolver(resolver: (() => NuxtApp | undefined) | undefined): void {
  nuxtAppResolver = resolver
}

/** The state of a client hook, such as `useSession()`, before Better Auth's client has loaded. */
const pendingState = (refetch: Callable) => ({ data: null, error: null, isPending: true, isRefetching: false, refetch })

/**
 * Better Auth's Vue client with the same options, types, and calls, which loads `better-auth/vue` the first time it is
 * used. Creating one costs nothing, so an app can create it up front and only pages that sign in pay for Better Auth.
 * Calls such as `signIn.social()` wait for the load. Hooks such as `useSession()` return a ref at once that is
 * pending until then, and stays pending during server rendering. Use `loadAuthClient()` for anything else, such as `$store`.
 */
export const createAuthClient: typeof createBetterAuthClient = <Option extends BetterAuthClientOptions>(options?: Option) => {
  let loaded: Promise<VueAuthClient<Option>> | undefined
  const load = () => (loaded ??= import("better-auth/vue").then(module => module.createAuthClient(options)))

  function hook(name: string, args: unknown[]) {
    const scope = getCurrentScope()
    const nuxtApp = nuxtAppResolver?.() || getCurrentInstance()?.appContext.config.globalProperties.$nuxt as NuxtApp | undefined
    // SAFETY: `name` is one of the client's `use*` hooks.
    const real = (client: VueAuthClient<Option>) => (Reflect.get(client, name) as Callable)(...args)
    // Better Auth's `useSession(useFetch)` for Nuxt answers with a promise, so it can wait for the load too.
    if (typeof args[0] === "function") return load().then(client => runIn(scope, () => nuxtApp ? nuxtApp.runWithContext(() => real(client)) : real(client)))
    const pending = pendingState(async (...query: unknown[]) => {
      await load()
      const current = state.value as { refetch?: Callable }
      return current === pending ? undefined : current.refetch?.(...query)
    })
    const state = shallowRef<unknown>(pending)
    if (!("window" in globalThis)) return state
    void load().then((client) => {
      if (scope && !scope.active) return
      runIn(scope, () => watch(real(client) as Ref<unknown>, value => (state.value = value), { immediate: true }))
    })
    return state
  }

  function call(path: string[]): unknown {
    return new Proxy(function () {}, {
      get(_, key) {
        if (key === LOAD && !path.length) return load
        // Like Better Auth's own client: no symbols, and never a thenable.
        if (typeof key !== "string" || key === "then" || key === "catch" || key === "finally") return undefined
        if (!path.length && /^use[A-Z]/.test(key)) return (...args: unknown[]) => hook(key, args)
        return call([...path, key])
      },
      async apply(_, __, args) {
        const client = await load()
        // SAFETY: Better Auth's client resolves every path to a callable endpoint, as it does for its own calls.
        const target = path.reduce<unknown>((node, key) => Reflect.get(Object(node), key), client) as Callable
        return target(...args)
      },
    })
  }

  // SAFETY: the proxy answers every member of Better Auth's Vue client: calls through `apply`, hooks through `hook`.
  return call([]) as VueAuthClient<Option>
}

/** Run `run` in the scope the hook was called in, so its watchers stop with the component that called it. */
function runIn<T>(scope: EffectScope | undefined, run: () => T): T | undefined {
  return scope ? scope.run(run) : run()
}

/** Better Auth's own Vue client behind one that `createAuthClient()` returned, once it has loaded. */
export async function loadAuthClient<Client extends VueAuthClient<any>>(client: Client): Promise<Client> {
  const load = Reflect.get(client, LOAD) as (() => Promise<Client>) | undefined
  return load ? await load() : client
}

export const authClient: VueAuthClient<{}> = createAuthClient({ basePath: resolveAuthMountPath("/api/auth") })

export function useAuthClient(): typeof authClient {
  return authClient
}

export interface AuthSessionState<Client extends VueAuthClient<any> = typeof authClient> {
  data: Client["$Infer"]["Session"] | null
  error: BetterFetchError | null
  isPending: boolean
  isRefetching: boolean
  refetch: (queryParams?: { query?: SessionQueryParams }) => Promise<void>
}

type AuthSessionRef<Client extends VueAuthClient<any> = typeof authClient> = DeepReadonly<Ref<AuthSessionState<Client>>>

export function useSession<Client extends VueAuthClient<any> = typeof authClient>(client: Client = authClient as Client): AuthSessionRef<Client> {
  return client.useSession() as AuthSessionRef<Client>
}

type ClientSession<Client extends VueAuthClient<any>> = Client["$Infer"]["Session"]

export interface UserSession<Client extends VueAuthClient<any> = typeof authClient> {
  data: ComputedRef<ClientSession<Client> | null>
  error: ComputedRef<BetterFetchError | null>
  /** The id of the administrator who opened this session as `user`, or `null`. Better Auth's admin plugin sets it. */
  impersonatedBy: ComputedRef<string | null>
  loggedIn: ComputedRef<boolean>
  pending: ComputedRef<boolean>
  ready: ComputedRef<boolean>
  refresh: () => Promise<void>
  session: ComputedRef<ClientSession<Client>["session"] | null>
  signIn: Client["signIn"]
  signOut: Client["signOut"]
  signUp: Client["signUp"]
  /** End the impersonation session and restore the administrator's own session. */
  stopImpersonating: () => Promise<void>
  user: ComputedRef<ClientSession<Client>["user"] | null>
}

export function useUserSession<Client extends VueAuthClient<any> = typeof authClient>(client: Client = authClient as Client): UserSession<Client> {
  const state = client.useSession() as AuthSessionRef<Client>
  return {
    data: computed(() => state.value.data),
    error: computed(() => state.value.error),
    impersonatedBy: computed(() => {
      const value: unknown = state.value.data?.session ? Reflect.get(state.value.data.session, "impersonatedBy") : undefined
      return typeof value === "string" && value ? value : null
    }),
    loggedIn: computed(() => Boolean(state.value.data?.session && state.value.data?.user)),
    pending: computed(() => state.value.isPending || state.value.isRefetching),
    ready: computed(() => !state.value.isPending),
    refresh: () => state.value.refetch(),
    session: computed(() => state.value.data?.session ?? null),
    signIn: client.signIn,
    signOut: client.signOut,
    signUp: client.signUp,
    async stopImpersonating() {
      // The path works without Better Auth's `adminClient()` plugin on the client.
      await client.$fetch("/admin/stop-impersonating", { method: "POST", body: {}, throw: true })
      await state.value.refetch()
    },
    user: computed(() => state.value.data?.user ?? null),
  }
}

export function useSignIn(): typeof authClient.signIn {
  return authClient.signIn
}

export function useSignUp(): typeof authClient.signUp {
  return authClient.signUp
}
