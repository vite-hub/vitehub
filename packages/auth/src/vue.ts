import abilities from "#vitehub/auth/abilities"
import { computed, defineComponent, effectScope, getCurrentInstance, getCurrentScope, inject, onScopeDispose, provide, shallowRef, watch } from "vue"

import { checkAbility } from "./ability-check.ts"
import { resolveAuthMountPath } from "./application-path.ts"

import type { BetterAuthClientOptions, SessionQueryParams } from "better-auth"
import type { createAuthClient as createBetterAuthClient, BetterFetchError, VueAuthClient } from "better-auth/vue"
import type { ComputedRef, DeepReadonly, EffectScope, InjectionKey, Ref, VNode } from "vue"
import type { AbilityArgs, AbilityName, AbilityRefusal } from "./abilities.ts"
import type { AbilityCheckRefusal } from "./ability-check.ts"

export type { VueAuthClient } from "better-auth/vue"

const LOAD = Symbol.for("vitehub.auth.client.load")
const ON_LOAD = Symbol.for("vitehub.auth.client.on-load")
const OPTIONS = Symbol.for("vitehub.auth.client.options")

type Callable = (...args: unknown[]) => unknown
type NuxtApp = { runWithContext<T>(run: () => T): T, $vitehubAuthClient?: VueAuthClient<any> }
type SessionQuery = { query?: SessionQueryParams }
type SessionState = { data: unknown, error: unknown, isPending: boolean, isRefetching: boolean, refetch: (query?: SessionQuery) => Promise<unknown> }

const authClientKey: InjectionKey<VueAuthClient<any>> = Symbol("vitehub.auth.client")

let nuxtAppResolver: (() => NuxtApp | undefined) | undefined
let sessionSeedResolver: (() => unknown) | undefined
let signOutHandler: ((redirectTo: string | undefined) => unknown) | undefined

/** Internal bridge installed by the Nuxt module, without making `#app` a dependency of this entry. */
export function setNuxtAppResolver(resolver: (() => NuxtApp | undefined) | undefined): void {
  nuxtAppResolver = resolver
}

/**
 * Internal bridge installed by the Nuxt module in the browser. `signOut()` of `useUserSession()` calls it after a
 * sign-out. It forgets the session that the server read, and opens `redirectTo`, or the login page when the page on
 * screen is only for signed-in visitors.
 */
export function setSignOutHandler(handler: ((redirectTo: string | undefined) => unknown) | undefined): void {
  signOutHandler = handler
}

/**
 * Internal bridge installed by the Nuxt module. The resolver returns the session that the server read for this
 * request, `null` when the request had none, or `undefined` when nobody knows yet, such as on a prerendered page.
 */
export function setSessionSeedResolver(resolver: (() => unknown) | undefined): void {
  sessionSeedResolver = resolver
}

/** The state of a client hook, such as `useSession()`, before Better Auth's client has loaded. */
const pendingState = <Refetch>(refetch: Refetch) => ({ data: null, error: null, isPending: true, isRefetching: false, refetch })

/**
 * Better Auth's Vue client with the same options, types, and calls, which loads `better-auth/vue` the first time it is
 * used. Creating one costs nothing, so an app can create it up front and only pages that sign in pay for Better Auth.
 * Calls such as `signIn.social()` wait for the load. Hooks such as `useSession()` return a ref at once that is
 * pending until then. Every `useSession()` call of one client in one app returns the same ref. In Nuxt, it starts with
 * the session that the server read for the request, so it is settled during server rendering and hydration. The
 * browser then loads Better Auth and reads the session again only when the session can change: a call, `refetch()`,
 * the tab shows again, the network comes back, another tab signs out or updates the user, or the session expires. Use
 * `loadAuthClient()` for anything else, such as `$store`.
 */
export const createAuthClient: typeof createBetterAuthClient = <Option extends BetterAuthClientOptions>(options?: Option) => {
  let loaded: Promise<VueAuthClient<Option>> | undefined
  let betterAuth: VueAuthClient<Option> | undefined
  // Run when Better Auth loads, before the first call runs, such as the session store that follows this client.
  const onLoad = new Set<(client: VueAuthClient<Option>) => void>()
  const load = () => (loaded ??= import("better-auth/vue").then((module) => {
    betterAuth = module.createAuthClient(options)
    for (const run of onLoad) run(betterAuth)
    onLoad.clear()
    return betterAuth
  }))
  const whenLoaded = (run: (client: VueAuthClient<Option>) => void) => {
    if (betterAuth) run(betterAuth)
    else onLoad.add(run)
  }

  function hook(name: string, args: unknown[]) {
    // One session state per app, which every caller shares. See `sessionStore()`.
    if (name === "useSession" && typeof args[0] !== "function") return sessionStore(client).state
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
    const initial = pendingState(refetch)
    const state = shallowRef<unknown>(initial)
    if (!("window" in globalThis)) return state
    void load().then((loaded) => {
      if (scope && !scope.active) return
      runIn(scope, () => watch(real(loaded) as Ref<unknown>, (value) => {
        state.value = value
      }, { immediate: true }))
    })
    return state
  }

  function call(path: string[]): unknown {
    return new Proxy(function () {}, {
      get(_, key) {
        if (key === LOAD && !path.length) return load
        if (key === ON_LOAD && !path.length) return whenLoaded
        if (key === OPTIONS && !path.length) return options
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
  const client = call([]) as VueAuthClient<Option>
  return client
}

function isPendingWithoutData(value: unknown): boolean {
  return typeof value === "object" && value !== null && Reflect.get(value, "isPending") === true && !Reflect.get(value, "data")
}

/** Run `run` in the scope the hook was called in, so its watchers stop with the component that called it. */
function runIn<T>(scope: EffectScope | undefined, run: () => T): T | undefined {
  return scope ? scope.run(run) : run()
}

/** The session state of one client in one app, which `useSession()`, `useUserSession()`, and the page guard share. */
interface SessionStore {
  state: Readonly<Ref<SessionState>>
  /** Reads the session, updates `state`, and returns the session. Callers at the same time share one read. */
  read: (query?: SessionQuery) => Promise<unknown>
  /** Sets the session that the server read for the request, if it is known now and nothing settled the state yet. */
  seed: () => void
  /** Sets the session to `null` at once, such as after a sign-out. */
  clear: () => void
  /** Keeps the browser's wait for a change of the session while `scope` lives. See `wakeWhenSessionCanChange()`. */
  hold: (scope: EffectScope | undefined) => void
  /** The scope of the store's computed refs and its one watcher. It never stops, as the store lives as long as the app. */
  scope: EffectScope
  /** The object that `useUserSession()` returns, made once. */
  userSession?: unknown
}

/** The owner of the stores in the browser: one page has one session per client. */
const browserOwner = {}
const stores = new WeakMap<object, WeakMap<object, SessionStore>>()

/**
 * The session store of `client` for the current app. The browser has one store per client. The server has one per
 * request, through the request's Nuxt app or Vue app, so two requests never share a session. On the server, a call
 * outside an app, such as at module scope, gets a store of its own.
 */
function sessionStore(client: object): SessionStore {
  const browser = "window" in globalThis
  const app = browser ? undefined : nuxtAppResolver?.()
  const owner = browser ? browserOwner : app ?? getCurrentInstance()?.appContext.app
  if (!owner) return createSessionStore(client, undefined)
  let byOwner = stores.get(client)
  if (!byOwner) stores.set(client, byOwner = new WeakMap())
  let store = byOwner.get(owner)
  if (!store) byOwner.set(owner, store = createSessionStore(client, app))
  // A store made before the session was known, such as at module scope, takes it from the first caller that knows it.
  else store.seed()
  store.hold(getCurrentScope())
  return store
}

function createSessionStore(client: object, app: NuxtApp | undefined): SessionStore {
  const browser = "window" in globalThis
  const scope = effectScope(true)
  const settled = (data: unknown): SessionState => ({ data, error: null, isPending: false, isRefetching: false, refetch })
  const state = shallowRef<SessionState>(pendingState(refetch))
  let seeded = false
  let reading: Promise<unknown> | undefined
  // Better Auth's session ref, which follows its session atom, once its client has loaded in the browser.
  let atom: Readonly<Ref<SessionState>> | undefined
  // The browser's wait for a change of the session, and the number of scopes that keep it.
  let stopWaking: (() => void) | undefined
  let holders = 0

  async function refetch(query?: SessionQuery): Promise<void> {
    await read(query)
  }

  /** Settles the state with the server's session. A promise of it, such as a read still in flight, is the read. */
  function seed(): void {
    if (seeded) return
    const value = sessionSeedResolver?.()
    if (value === undefined) return
    seeded = true
    if (!(value instanceof Promise)) {
      if (state.value.isPending) state.value = settled(value)
      return
    }
    reading ??= value.then((session: unknown) => {
      if (session !== undefined && state.value.isPending) state.value = settled(session)
      return session ?? null
    }).finally(() => {
      reading = undefined
    })
  }

  /**
   * Follows Better Auth's session atom with one watcher. It runs when Better Auth loads, before the first call of the
   * client runs, so the session signal of that call, such as after `signOut()`, reaches the state.
   */
  function connect(loaded: object): Readonly<Ref<SessionState>> {
    if (atom) return atom
    stopWaking?.()
    stopWaking = undefined
    // Start Better Auth's session with the server's, so a read that fails keeps it, as it does after a first read.
    const hydrateSession: unknown = Reflect.get(loaded, "hydrateSession")
    if (seeded && state.value.data && typeof hydrateSession === "function") hydrateSession.call(loaded, state.value.data)
    atom = scope.run(() => {
      // SAFETY: Better Auth's `useSession()` without an argument returns the ref of its session atom.
      const ref = (Reflect.get(loaded, "useSession") as () => Readonly<Ref<SessionState>>)()
      watch(ref, (value) => {
        // Better Auth starts each read with no data as pending. Once the state is settled, keep it until the read answers.
        if (!state.value.isPending && isPendingWithoutData(value)) return
        state.value = value
      }, { immediate: true, flush: "sync" })
      return ref
    })!
    return atom
  }

  /** Loads Better Auth in the browser and follows its session atom. */
  async function follow(): Promise<Readonly<Ref<SessionState>>> {
    return atom ?? connect(await loadAuthClient(client as VueAuthClient<{}>))
  }

  function hold(caller: EffectScope | undefined): void {
    if (!browser || atom || !seeded || state.value.isPending) return
    holders++
    stopWaking ??= wakeWhenSessionCanChange((Reflect.get(client, OPTIONS) as BetterAuthClientOptions | undefined)?.sessionOptions, state.value.data, () => void follow())
    // A caller outside a component, such as the page guard, keeps the wait as long as the page.
    if (caller) {
      runIn(caller, () => onScopeDispose(() => {
        if (--holders || !stopWaking) return
        stopWaking()
        stopWaking = undefined
      }))
    }
  }

  async function fetchSession(query?: SessionQuery): Promise<unknown> {
    if (!browser) {
      // The server never loads Better Auth's client. It has the session that it read for the request, or nothing.
      if (!state.value.isPending) return state.value.data
      const session: unknown = await (app ? app.runWithContext(() => sessionSeedResolver?.()) : sessionSeedResolver?.())
      if (session === undefined) return null
      state.value = settled(session)
      return session
    }
    const followed = await follow()
    // Better Auth writes the answer to its atom, and the watcher writes it to the state before `refetch()` resolves.
    await followed.value.refetch(query)
    // Better Auth cancels a read when it starts a later one, such as after a sign-in or on window focus, and the
    // cancelled read resolves without an answer. Wait for the answer of the later read.
    if (followed.value.isRefetching) await settledAtom(followed)
    return state.value.data ?? null
  }

  function settledAtom(followed: Readonly<Ref<SessionState>>): Promise<void> {
    return new Promise((resolve) => {
      const stop = scope.run(() => watch(followed, (value) => {
        if (value.isRefetching) return
        stop?.()
        resolve()
      }, { flush: "sync" }))
    })
  }

  function read(query?: SessionQuery): Promise<unknown> {
    // A read with its own query, such as `disableCookieCache`, does not share the read in flight.
    if (query) return fetchSession(query)
    return reading ??= fetchSession().finally(() => {
      reading = undefined
    })
  }

  seed()
  if (browser) {
    // Any load of the client, such as for a call, follows Better Auth before the call runs.
    const whenLoaded = Reflect.get(client, ON_LOAD) as ((run: (loaded: object) => void) => void) | undefined
    whenLoaded?.(connect)
    // Better Auth reads the session when its atom first mounts. The server read it for this page a moment ago, so a
    // store with the server's session waits until the session can change. An unknown session loads Better Auth at once.
    if (!seeded || state.value.isPending) void follow()
  }
  return { state, read, seed, clear: () => void (state.value = settled(null)), hold, scope }
}

/** The browser globals that the wait listens to. The package compiles without the DOM types. */
type BrowserGlobals = { window?: EventTarget, document?: EventTarget & { visibilityState?: string }, navigator?: { onLine?: boolean } }

/** The longest delay that `setTimeout()` keeps. It runs a longer delay at once. */
const maxTimerDelay = 2 ** 31 - 1

/** Better Auth's channel to other tabs: a tab writes this `localStorage` key when it signs out or updates the user or session. */
const sessionChannelKey = "better-auth.message"

/**
 * Calls `wake` at the moments when Better Auth reads the session again: the tab shows again (unless
 * `refetchOnWindowFocus` is `false`), the network comes back, another tab changes the session, `refetchInterval`
 * passes, or the session expires. Like Better Auth, it waits while the browser is offline, unless `refetchWhenOffline`
 * is `true`: Better Auth could not load then, and the `online` event wakes it later. Returns a function that removes
 * the listeners.
 */
function wakeWhenSessionCanChange(options: BetterAuthClientOptions["sessionOptions"], seed: unknown, wake: () => void): () => void {
  const stops: Array<() => void> = []
  const { document: page, navigator, window } = globalThis as BrowserGlobals
  const wakeOnline = () => {
    if (navigator?.onLine === false && options?.refetchWhenOffline !== true) return
    wake()
  }
  const listen = (target: EventTarget | undefined, type: string, when: (event: Event) => boolean = () => true) => {
    if (typeof target?.addEventListener !== "function") return
    const listener = (event: Event) => when(event) && wakeOnline()
    target.addEventListener(type, listener)
    stops.push(() => target.removeEventListener(type, listener))
  }
  if (options?.refetchOnWindowFocus !== false) listen(page, "visibilitychange", () => page?.visibilityState === "visible")
  listen(window, "online")
  listen(window, "storage", event => Reflect.get(event, "key") === sessionChannelKey)
  const session: unknown = typeof seed === "object" && seed !== null ? Reflect.get(seed, "session") : undefined
  const expiresAt: unknown = typeof session === "object" && session !== null ? Reflect.get(session, "expiresAt") : undefined
  const times: number[] = []
  if (expiresAt instanceof Date || typeof expiresAt === "string" || typeof expiresAt === "number") times.push(new Date(expiresAt).getTime())
  // Better Auth polls only a signed-in session.
  if (session && options?.refetchInterval && options.refetchInterval > 0) times.push(Date.now() + options.refetchInterval * 1000)
  const at = Math.min(...times.filter(Number.isFinite))
  if (Number.isFinite(at)) {
    // A session that ends after the longest delay wakes then. An early read is safe.
    const timer = setTimeout(wakeOnline, Math.min(Math.max(at - Date.now(), 0), maxTimerDelay))
    stops.push(() => clearTimeout(timer))
  }
  return () => {
    for (const stop of stops) stop()
  }
}

/** Better Auth's own Vue client behind one that `createAuthClient()` returned, once it has loaded. */
export async function loadAuthClient<Client extends VueAuthClient<any>>(client: Client): Promise<Client> {
  const load = Reflect.get(client, LOAD) as (() => Promise<Client>) | undefined
  return load ? await load() : client
}

/** The options of the default client. The Nuxt module sets the Auth Definition's `basePath` before the client loads. */
const defaultClientOptions = { basePath: resolveAuthMountPath("/api/auth") }

export const authClient: VueAuthClient<{}> = createAuthClient(defaultClientOptions)

/**
 * Internal bridge installed by the Nuxt module: the Auth Definition's `basePath`, below Nuxt `app.baseURL`, for the
 * default client. The page guard and the auto-imported composables then share one client and one session.
 */
export function setDefaultAuthBasePath(basePath: string): void {
  defaultClientOptions.basePath = basePath
}

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

/**
 * The session of `client`. Every call for the same client in the same app returns the same ref, so a list of
 * components that call it costs one watcher. In Nuxt, the page guard reads the session into the same ref.
 */
export function useSession<Client extends VueAuthClient<any> = typeof authClient>(client: Client = useAuthClient() as Client): AuthSessionRef<Client> {
  // SAFETY: the store holds the state of Better Auth's `useSession()` for this client.
  return sessionStore(client).state as unknown as AuthSessionRef<Client>
}

type ClientSession<Client extends VueAuthClient<any>> = Client["$Infer"]["Session"]

/** The options of `signOut()` from `useUserSession()`: the options of Better Auth's `signOut()`, and `redirectTo`. */
export type SignOutOptions<Client extends VueAuthClient<any> = typeof authClient> = NonNullable<Parameters<Client["signOut"]>[0]> & {
  /**
   * The page to open after the sign-out. Without it, in Nuxt, a page that only signed-in visitors may open sends the
   * visitor to the login page, as its page guard does.
   */
  redirectTo?: string
}

export interface UserSession<Client extends VueAuthClient<any> = typeof authClient> {
  data: ComputedRef<ClientSession<Client> | null>
  error: ComputedRef<BetterFetchError | null>
  /** The id of the administrator who opened this session as `user`, or `null`. Better Auth's admin plugin sets it. */
  impersonatedBy: ComputedRef<string | null>
  loggedIn: ComputedRef<boolean>
  pending: ComputedRef<boolean>
  /** `true` once the session was read. It stays `true` while a later read runs, and after a read that failed. */
  ready: ComputedRef<boolean>
  /**
   * Reads the session again, updates every ref, and returns the session, or `null` without one. Callers at the same
   * time share one read. On the server, it returns the session that the server read for the request.
   */
  refresh: () => Promise<ClientSession<Client> | null>
  session: ComputedRef<ClientSession<Client>["session"] | null>
  signIn: Client["signIn"]
  /**
   * Signs out with Better Auth, sets the session to `null` at once, then opens `redirectTo`. Returns Better Auth's
   * result. When the sign-out fails, the session and the page stay.
   */
  signOut: (options?: SignOutOptions<Client>) => ReturnType<Client["signOut"]>
  signUp: Client["signUp"]
  /** End the impersonation session and restore the administrator's own session. */
  stopImpersonating: () => Promise<void>
  user: ComputedRef<ClientSession<Client>["user"] | null>
}

/**
 * The current user and session of `client`, with sign-in and sign-out actions. Every call for the same client in the
 * same app returns the same object, so a list of components that call it costs nothing more.
 */
export function useUserSession<Client extends VueAuthClient<any> = typeof authClient>(client: Client = useAuthClient() as Client): UserSession<Client> {
  const store = sessionStore(client)
  // SAFETY: the store makes this object once, for this client.
  return (store.userSession ??= store.scope.run(() => createUserSession(client, store))) as UserSession<Client>
}

function createUserSession<Client extends VueAuthClient<any>>(client: Client, store: SessionStore): UserSession<Client> {
  // SAFETY: the store holds the state of Better Auth's `useSession()` for this client.
  const state = store.state as unknown as AuthSessionRef<Client>
  // SAFETY: `read()` returns the session of this client, or `null`.
  const refresh = store.read as () => Promise<ClientSession<Client> | null>
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
    refresh,
    session: computed(() => state.value.data?.session ?? null),
    signIn: client.signIn,
    signOut: options => signOut(client, store, options) as ReturnType<Client["signOut"]>,
    signUp: client.signUp,
    async stopImpersonating() {
      // The path works without Better Auth's `adminClient()` plugin on the client.
      await client.$fetch("/admin/stop-impersonating", { method: "POST", body: {}, throw: true })
      await refresh()
    },
    user: computed(() => state.value.data?.user ?? null),
  }
}

async function signOut(client: { signOut(options: object): Promise<unknown> }, store: SessionStore, options: { redirectTo?: string } = {}): Promise<unknown> {
  const { redirectTo, ...betterAuthOptions } = options
  const result = await client.signOut(betterAuthOptions)
  // Better Auth returns `{ data, error }`, and only the data with `fetchOptions.throw`, which throws on an error.
  const answer = typeof result === "object" && result !== null && "data" in result && "error" in result ? result : { data: result, error: null }
  if (answer.error) return result
  if (!("window" in globalThis)) return result
  // Better Auth reads the session again after a sign-out, and the page shows the user until it answers. Its session
  // atom starts that read from `null`, so the read cannot show the user again. Every component shares the store, so
  // they all show the sign-out at once.
  const session = (await loadAuthClient(client as VueAuthClient<{}>)).$store?.atoms?.session
  session?.set({ ...session.get(), data: null, error: null, isPending: false })
  store.clear()
  // A provider sign-out, such as OpenID Connect logout, answers `{ url, redirect: true }`, and Better Auth then
  // loads the provider's page. Another navigation now would cancel it.
  const data: unknown = answer.data
  if (typeof data === "object" && data !== null && Reflect.get(data, "redirect") === true && typeof Reflect.get(data, "url") === "string") return result
  // Nuxt opens the next page with `navigateTo()`. Plain Vue knows no router, so it loads `redirectTo`. The package
  // types have no DOM, so `location` comes from `globalThis`.
  if (signOutHandler) await signOutHandler(redirectTo)
  else if (redirectTo) (globalThis as { location?: { assign(url: string): void } }).location?.assign(redirectTo)
  return result
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
export function useAbility(client: VueAuthClient<any> = useAuthClient()): Ability {
  const state = useSession(client)
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
