import abilities from "#vitehub/auth/abilities"
import { computed, defineComponent, getCurrentInstance, getCurrentScope, inject, provide, shallowRef, watch } from "vue"

import { checkAbility } from "./ability-check.ts"
import { AbilityError } from "./ability-error.ts"
import { resolveAuthMountPath } from "./application-path.ts"

import type { BetterAuthClientOptions, SessionQueryParams } from "better-auth"
import type { createAuthClient as createBetterAuthClient, BetterFetchError, VueAuthClient } from "better-auth/vue"
import type { ComputedRef, DeepReadonly, EffectScope, InjectionKey, Ref, VNode } from "vue"
import type { AbilityArgs, AbilityName, AbilityRefusal } from "./abilities.ts"
import type { AbilityCheckRefusal } from "./ability-check.ts"
import type { AbilityErrorData } from "./ability-error.ts"

export type { VueAuthClient } from "better-auth/vue"

const LOAD = Symbol.for("vitehub.auth.client.load")

type Callable = (...args: unknown[]) => unknown
type NuxtApp = { runWithContext<T>(run: () => T): T, isHydrating?: boolean, $vitehubAuthClient?: VueAuthClient<any> }

const authClientKey: InjectionKey<VueAuthClient<any>> = Symbol("vitehub.auth.client")

/** What `authorize()` passes to Nuxt's `createError()`: the refusal, as the server sends it, and `fatal`. */
type NuxtErrorInput = { status: number, statusText: string, message: string, data: AbilityErrorData, fatal: true }

let nuxtAppResolver: (() => NuxtApp | undefined) | undefined
let nuxtErrorFactory: ((input: NuxtErrorInput) => Error) | undefined
let sessionSeedResolver: (() => unknown) | undefined

/** Internal bridge installed by the Nuxt module, without making `#app` a dependency of this entry. */
export function setNuxtAppResolver(resolver: (() => NuxtApp | undefined) | undefined): void {
  nuxtAppResolver = resolver
}

/** Internal bridge installed by the Nuxt module: Nuxt's `createError()`, so a refusal of `authorize()` shows the error page. */
export function setNuxtErrorFactory(factory: ((input: NuxtErrorInput) => Error) | undefined): void {
  nuxtErrorFactory = factory
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
  // A failed load, such as a chunk that a flaky network did not deliver, lets the next call try again.
  const load = () => (loaded ??= import("better-auth/vue").then(module => module.createAuthClient(options)).catch((error: unknown) => {
    loaded = undefined
    throw error
  }))

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

/** Provide the app's configured client to Auth composables and `<Can>` in descendant components. */
export function provideAuthClient(client: VueAuthClient<any>): void {
  provide(authClientKey, client)
}

export function useAuthClient(): typeof authClient {
  const instance = getCurrentInstance()
  const client = instance ? inject(authClientKey, undefined) : undefined
  const nuxtApp = nuxtAppResolver?.() || instance?.appContext.config.globalProperties.$nuxt as NuxtApp | undefined
  return client ?? nuxtApp?.$vitehubAuthClient ?? authClient
}

export interface AuthSessionState<Client extends VueAuthClient<any> = typeof authClient> {
  data: Client["$Infer"]["Session"] | null
  error: BetterFetchError | null
  isPending: boolean
  isRefetching: boolean
  refetch: (queryParams?: { query?: SessionQueryParams }) => Promise<void>
}

type AuthSessionRef<Client extends VueAuthClient<any> = typeof authClient> = DeepReadonly<Ref<AuthSessionState<Client>>>

export function useSession<Client extends VueAuthClient<any> = typeof authClient>(client: Client = useAuthClient() as Client): AuthSessionRef<Client> {
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

export function useUserSession<Client extends VueAuthClient<any> = typeof authClient>(client: Client = useAuthClient() as Client): UserSession<Client> {
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

/** What `useAbility()` returns. */
export interface Ability {
  /**
   * Whether a rule from `shared/abilities.ts` allows the visitor: `undefined` until the session is known. The arguments
   * are passed as they are, so load the data before you ask.
   */
  can: <const Name extends AbilityName>(name: Name, ...args: AbilityArgs<Name>) => boolean | undefined
  /** Whether a rule refuses the visitor: the opposite of `can()`, and `undefined` until the session is known. */
  cannot: <const Name extends AbilityName>(name: Name, ...args: AbilityArgs<Name>) => boolean | undefined
  /**
   * Checks a rule and throws when it refuses, with the status and the `{ code, details }` data that `requireAbility()`
   * sends. In Nuxt, the error is fatal, so the page shows the error page. In the browser, except while Nuxt hydrates,
   * it asks Better Auth's `/get-session` for the current session. On the server, a session that the server could not
   * read counts as signed out.
   */
  authorize: <const Name extends AbilityName>(name: Name, ...args: AbilityArgs<Name>) => Promise<void>
  /** `true` once the session is known. */
  ready: ComputedRef<boolean>
}

type SessionState = { isPending: boolean, data: { user: object } | null }

/** The refusal of a rule for the visitor: `undefined` while the session is unknown, `null` when the rule allows. */
function abilityRefusal(state: SessionState, name: string, args: unknown[]): AbilityCheckRefusal | null | undefined {
  if (state.isPending) return undefined
  return checkAbility(abilities, state.data?.user ?? null, name, args)
}

/**
 * The user that `authorize()` checks. The server uses the session it read for the request. While Nuxt hydrates, the
 * browser uses the same session, so it decides as the server did. Otherwise the browser asks the client of
 * `useAbility()`, because a sign-in or sign-out in the tab makes the server's session old. In Nuxt, that is the client of
 * the page guard, at the configured Auth `basePath` below `app.baseURL`.
 */
async function authorizedUser(client: Pick<typeof authClient, "getSession">, state: Readonly<Ref<SessionState>>): Promise<object | null> {
  const known = !state.value.isPending
  if (!("window" in globalThis) || (known && nuxtAppResolver?.()?.isHydrating)) return state.value.data?.user ?? null
  const { data } = await client.getSession()
  return data?.user ?? null
}

/**
 * Checks the rules of `shared/abilities.ts` in the app, with the same rules the server runs. Read `can()` and
 * `cannot()` in a template or a `computed()`, so they follow the session. Call `authorize()` in a page that the visitor
 * must not see when the rule refuses.
 *
 * @example
 * const { can, authorize } = useAbility()
 * const editable = computed(() => post.value && can("posts.edit", post.value))
 * // In a page, after the post loads:
 * await authorize("posts.edit", loadedPost)
 */
export function useAbility(client: VueAuthClient<any> = useAuthClient()): Ability {
  const state = useSession(client)
  const allows = (name: string, args: unknown[]) => {
    const refusal = abilityRefusal(state.value, name, args)
    return refusal === undefined ? undefined : refusal === null
  }
  return {
    can: (name, ...args) => allows(name, args),
    cannot: (name, ...args) => {
      const allowed = allows(name, args)
      return allowed === undefined ? undefined : !allowed
    },
    authorize: async (name, ...args) => {
      const refusal = checkAbility(abilities, await authorizedUser(client, state), name, args)
      if (!refusal) return
      const error = new AbilityError(refusal)
      throw nuxtErrorFactory ? nuxtErrorFactory({ ...error.toJSON(), fatal: true }) : error
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

/** The runtime props of `<Can>` and `<Cannot>`. */
const abilityProps = {
  do: { type: String, required: true },
  with: { type: null, default: undefined },
  args: { type: Array, default: undefined },
  pending: { type: Boolean, default: false },
} as const

/** The refusal of the rule that the props name. It follows the session, and is `undefined` while `pending` is `true`. */
function usePropsRefusal(props: { do: string, with: unknown, args?: unknown[], pending: boolean }): ComputedRef<AbilityCheckRefusal | null | undefined> {
  const state = useSession()
  return computed(() => {
    if (props.pending) return undefined
    // `with` is the one argument of the rule. Without it, an optional argument stays absent, as in `can(name)`.
    const args: unknown[] = props.args ?? (props.with === undefined ? [] : [props.with])
    return abilityRefusal(state.value, props.do, args)
  })
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
  props: abilityProps,
  setup(props, { slots }) {
    const refusal = usePropsRefusal(props)
    return () => {
      const value = refusal.value
      if (value === undefined) return null
      if (value === null) return slots.default?.()
      return slots.denied?.({ code: value.code, details: value.details })
    }
  },
}) as unknown as CanComponent

/** The slot of `<Cannot>`: its content, with the refusal, when the rule refuses. */
export interface CannotSlots<Name extends AbilityName> {
  default?: (refusal: AbilityRefusal<Name>) => VNode[]
}

/** The type that vue-tsc reads for `<Cannot>`: the props of `<Can>`, and the refusal in the default slot. */
export type CannotComponent = <const Name extends AbilityName>(props: CanProps<Name>) => VNode & {
  __ctx?: { props: CanProps<Name>, slots: CannotSlots<Name> }
}

/**
 * The mirror of `<Can>`: shows its content, with the refusal, only when a rule from `shared/abilities.ts` refuses the
 * visitor. It shows nothing when the rule allows, while the session is unknown, or while `pending` is `true`.
 *
 * @example
 * <Cannot do="billing.upgrade" v-slot="{ code, details }">
 *   <UpgradeHint :code="code" :limit="details.limit" />
 * </Cannot>
 */
// SAFETY: the runtime component takes the props of `CannotComponent`. The cast gives templates its generic types.
export const Cannot: CannotComponent = defineComponent({
  name: "Cannot",
  props: abilityProps,
  setup(props, { slots }) {
    const refusal = usePropsRefusal(props)
    return () => {
      const value = refusal.value
      return value ? slots.default?.({ code: value.code, details: value.details }) : null
    }
  },
}) as unknown as CannotComponent
