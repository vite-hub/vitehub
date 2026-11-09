import abilities from "#vitehub/auth/abilities"
import { computed, defineComponent, getCurrentInstance, getCurrentScope, shallowRef, watch } from "vue"

import { checkAbility } from "./ability-check.ts"
import { resolveAuthMountPath } from "./application-path.ts"

import type { BetterAuthClientOptions, SessionQueryParams } from "better-auth"
import type { createAuthClient as createBetterAuthClient, BetterFetchError, VueAuthClient } from "better-auth/vue"
import type { ComputedRef, DeepReadonly, EffectScope, Ref, VNode } from "vue"
import type { AbilityArgs, AbilityName, AbilityRefusal } from "./abilities.ts"
import type { AbilityCheckRefusal } from "./ability-check.ts"

export type { VueAuthClient } from "better-auth/vue"

const LOAD = Symbol.for("vitehub.auth.client.load")

type Callable = (...args: unknown[]) => unknown
type NuxtApp = { runWithContext<T>(run: () => T): T }

let nuxtAppResolver: (() => NuxtApp | undefined) | undefined
let sessionSeedResolver: (() => unknown) | undefined

/** Internal bridge installed by the Nuxt module, without making `#app` a dependency of this entry. */
export function setNuxtAppResolver(resolver: (() => NuxtApp | undefined) | undefined): void {
  nuxtAppResolver = resolver
}

/**
 * Internal bridge installed by the Nuxt module. The resolver returns the session that the server read for this
 * request, `null` when the request had none, or `undefined` when nobody knows yet, such as on a prerendered page.
 */
export function setSessionSeedResolver(resolver: (() => unknown) | undefined): void {
  sessionSeedResolver = resolver
}

/** The state of a client hook, such as `useSession()`, before Better Auth's client has loaded. */
const pendingState = (refetch: Callable) => ({ data: null, error: null, isPending: true, isRefetching: false, refetch })

/**
 * Better Auth's Vue client with the same options, types, and calls, which loads `better-auth/vue` the first time it is
 * used. Creating one costs nothing, so an app can create it up front and only pages that sign in pay for Better Auth.
 * Calls such as `signIn.social()` wait for the load. Hooks such as `useSession()` return a ref at once that is
 * pending until then. In Nuxt, `useSession()` starts with the session that the server read for the request, so it is
 * settled during server rendering and hydration. Use `loadAuthClient()` for anything else, such as `$store`.
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
    const refetch = async (...query: unknown[]) => {
      await load()
      const current = state.value as { refetch?: Callable }
      return current === initial ? undefined : current.refetch?.(...query)
    }
    // With a session that the server rendered, the hook starts settled, so the page does not flash signed out.
    const seed = name === "useSession" ? sessionSeedResolver?.() : undefined
    const initial = seed === undefined ? pendingState(refetch) : { data: seed, error: null, isPending: false, isRefetching: false, refetch }
    const state = shallowRef<unknown>(initial)
    if (!("window" in globalThis)) return state
    void load().then((client) => {
      if (scope && !scope.active) return
      runIn(scope, () => watch(real(client) as Ref<unknown>, (value) => {
        // Better Auth starts pending with no data. Keep the server's answer until Better Auth has its own.
        if (seed !== undefined && isPendingWithoutData(value)) return
        state.value = value
      }, { immediate: true }))
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

function isPendingWithoutData(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "isPending") === true && !Reflect.get(value, "data")
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

/** What `useAbility()` returns. */
export interface Ability {
  /**
   * Whether a rule from `shared/abilities.ts` allows the visitor: `undefined` until the session is known. The arguments
   * are passed as they are, so load the data before you ask.
   */
  can: <const Name extends AbilityName>(name: Name, ...args: AbilityArgs<Name>) => boolean | undefined
  /** `true` once the session is known. */
  ready: ComputedRef<boolean>
}

/** The refusal of a rule for the visitor: `undefined` while the session is unknown, `null` when the rule allows. */
function abilityRefusal(state: { isPending: boolean, data: { user: object } | null }, name: string, args: unknown[]): AbilityCheckRefusal | null | undefined {
  if (state.isPending) return undefined
  return checkAbility(abilities, state.data?.user ?? null, name, args)
}

/**
 * Checks the rules of `shared/abilities.ts` in the app, with the same rules the server runs. Read `can()` in a template
 * or a `computed()`, so it follows the session.
 *
 * @example
 * const { can } = useAbility()
 * const editable = computed(() => post.value && can("posts.edit", post.value))
 */
export function useAbility(): Ability {
  const state = useSession()
  return {
    can: (name, ...args) => {
      const refusal = abilityRefusal(state.value, name, args)
      return refusal === undefined ? undefined : refusal === null
    },
    ready: computed(() => !state.value.isPending),
  }
}

/**
 * How `<Can>` passes the arguments of a rule: no prop for a rule without arguments, `with` for a rule with one
 * (required or optional), and `args` with the list for every other rule, such as two arguments, a default after the
 * first, or a rest parameter.
 */
type CanArguments<Args extends unknown[]> = Args extends [] ? { with?: never, args?: never }
  : number extends Args["length"] ? { with?: never, args: Args }
    : Exclude<Args["length"], 0> extends 1
      ? (0 extends Args["length"] ? { with?: Args[0], args?: never } : { with: Args[0], args?: never })
      : { with?: never, args: Args }

/**
 * The props of `<Can>`: a rule name in `do`, its arguments in `with` or `args`, and `pending` to show nothing while
 * the data for the arguments loads.
 */
export type CanProps<Name extends AbilityName> = { do: Name, pending?: boolean } & CanArguments<AbilityArgs<Name>>

/** The slots of `<Can>`: the default slot when the rule allows, `#denied` with the refusal when it refuses. */
export interface CanSlots<Name extends AbilityName> {
  default?: () => VNode[]
  denied?: (refusal: AbilityRefusal<Name>) => VNode[]
}

/** The type that vue-tsc reads for a generic component, so `do` checks the name and `with`, `args` and `#denied` follow it. */
export type CanComponent = <const Name extends AbilityName>(props: CanProps<Name>) => VNode & {
  __ctx?: { props: CanProps<Name>, slots: CanSlots<Name> }
}

/**
 * Shows its content when a rule from `shared/abilities.ts` allows the visitor, the `#denied` slot with the refusal when
 * it refuses, and nothing while the session is unknown or `pending` is `true`.
 *
 * @example
 * <Can do="posts.edit" :with="post">
 *   <button>Edit</button>
 *   <template #denied="{ code }">{{ code }}</template>
 * </Can>
 * <Can do="posts.move" :args="[from, to]">Move</Can>
 */
// SAFETY: the runtime component takes the props of `CanComponent`. The cast gives templates its generic types.
export const Can: CanComponent = defineComponent({
  name: "Can",
  props: {
    do: { type: String, required: true },
    with: { type: null, default: undefined },
    args: { type: Array, default: undefined },
    pending: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const state = useSession()
    const refusal = computed(() => {
      if (props.pending) return undefined
      // `with` is the one argument of the rule. Without it, an optional argument stays absent, as in `can(name)`.
      const args: unknown[] = props.args ?? (props.with === undefined ? [] : [props.with])
      return abilityRefusal(state.value, props.do, args)
    })
    return () => {
      const value = refusal.value
      if (value === undefined) return null
      if (value === null) return slots.default?.()
      return slots.denied?.({ code: value.code, details: value.details })
    }
  },
}) as unknown as CanComponent
