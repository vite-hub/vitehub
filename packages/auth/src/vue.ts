import abilities from "#vitehub/auth/abilities"
import { computed, defineComponent, effectScope, getCurrentInstance, getCurrentScope, inject, onScopeDispose, onServerPrefetch, provide, shallowRef, watch } from "vue"

import { checkAbility } from "./ability-check.ts"
import { AbilityError } from "./ability-error.ts"
import { resolveAuthMountPath } from "./application-path.ts"

import type { BetterAuthClientOptions, SessionQueryParams } from "better-auth"
import type { inferAdditionalFields } from "better-auth/client/plugins"
import type { createAuthClient as createBetterAuthClient, BetterFetchError, VueAuthClient } from "better-auth/vue"
import type { ComputedRef, DeepReadonly, EffectScope, InjectionKey, Ref, VNode } from "vue"
import type { AbilityArgs, AbilityName, AbilityRefusal } from "./abilities.ts"
import type { AbilityCheckRefusal } from "./ability-check.ts"
import type { AbilityErrorData } from "./ability-error.ts"
import type { AuthDefinition, AuthFor } from "./types.ts"

export type { VueAuthClient } from "better-auth/vue"

const LOAD = Symbol.for("vitehub.auth.client.load")
const ON_LOAD = Symbol.for("vitehub.auth.client.on-load")
const OPTIONS = Symbol.for("vitehub.auth.client.options")

type Callable = (...args: unknown[]) => unknown
type NuxtApp = { runWithContext<T>(run: () => T): T, isHydrating?: boolean, $vitehubAuthClient?: AuthClientLike }
type SessionQuery = { query?: SessionQueryParams }
type SessionState = { data: unknown, error: unknown, isPending: boolean, isRefetching: boolean, refetch: (query?: SessionQuery) => Promise<unknown> }

const authClientKey: InjectionKey<AuthClientLike> = Symbol("vitehub.auth.client")

/**
 * The members of a client that the composables read. Every Better Auth Vue client has them. `VueAuthClient<any>`
 * rejects a client with a required additional field, because its `signUp.email()` needs that field.
 */
type AuthClientLike = Pick<VueAuthClient<{}>, "$fetch" | "getSession"> & {
  $Infer: { Session: { session: object, user: object } }
  signIn: unknown
  signOut: unknown
  signUp: unknown
  useSession: () => unknown
}

/** What `authorize()` passes to Nuxt's `createError()`: the refusal, as the server sends it, and `fatal`. */
type NuxtErrorInput = { status: number, statusText: string, message: string, data: AbilityErrorData, fatal: true }

/** The fetch of one server request, which Better Auth's client uses for the calls of that request. */
export interface RequestFetch {
  /** The same object for every call of one request, such as the Nuxt app of the request. */
  request: object
  /** The origin of the request. On the server, Better Auth's client needs an absolute URL. */
  origin: string
  /** Calls the app in-process with the headers of the request, such as the cookie. */
  fetch: typeof fetch
}

let nuxtAppResolver: (() => NuxtApp | undefined) | undefined
let nuxtErrorFactory: ((input: NuxtErrorInput) => Error) | undefined
let sessionSeedResolver: ((read: boolean) => unknown) | undefined
let signOutHandler: ((redirectTo: string | undefined) => unknown) | undefined
let defaultBasePath: string | undefined
let requestFetchResolver: (() => RequestFetch | undefined) | undefined

/** Internal bridge installed by the Nuxt module, without making `#app` a dependency of this entry. */
export function setNuxtAppResolver(resolver: (() => NuxtApp | undefined) | undefined): void {
  nuxtAppResolver = resolver
}

/** Internal bridge installed by the Nuxt module: Nuxt's `createError()`, so a refusal of `authorize()` shows the error page. */
export function setNuxtErrorFactory(factory: ((input: NuxtErrorInput) => Error) | undefined): void {
  nuxtErrorFactory = factory
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
 * Internal bridge installed by the Nuxt module: the path of Better Auth for the default `authClient`, such as
 * `/app/auth` for `defineAuth({ basePath: '/auth' })` below Nuxt `app.baseURL` `/app/`. The client reads it when it
 * loads Better Auth. Without it, the client uses `/api/auth` below the base path of the build.
 */
export function setDefaultAuthBasePath(path: string | undefined): void {
  defaultBasePath = path
}

/**
 * Internal bridge installed by the Nuxt module. The resolver returns the session that the server read for this
 * request, `null` when the request had none, or `undefined` when nobody knows yet, such as on a prerendered page.
 * With `read` on the server, it reads the session if the request did not read it yet, and can return a promise of it.
 */
export function setSessionSeedResolver(resolver: ((read: boolean) => unknown) | undefined): void {
  sessionSeedResolver = resolver
}

/**
 * Internal bridge installed by the Nuxt module. On the server, the resolver returns the fetch of the current request, or
 * `undefined` outside a request.
 */
export function setRequestFetchResolver(resolver: (() => RequestFetch | undefined) | undefined): void {
  requestFetchResolver = resolver
}

/** The state of a client hook, such as `useSession()`, before Better Auth's client has loaded. */
const pendingState = <Refetch>(refetch: Refetch) => ({ data: null, error: null, isPending: true, isRefetching: false, refetch })

/**
 * Better Auth's Vue client with the same options, types, and calls, which loads `better-auth/vue` the first time it is
 * used. Creating one costs nothing, so an app can create it up front and only pages that sign in pay for Better Auth.
 * Calls such as `signIn.social()` wait for the load. Hooks such as `useSession()` return a ref at once that is
 * pending until then. Every `useSession()` call of one client in one app returns the same ref. In Nuxt, a call in a
 * component starts with the session that the server read for the request, so it is settled during server rendering and
 * hydration. The browser then loads Better Auth and reads the session again only when the session can change: a call,
 * `refetch()`, the tab shows again, the network comes back, another tab signs out or updates the user, or the session
 * expires. Use `loadAuthClient()` for anything else, such as `$store`. Without `basePath`, it uses the same default
 * as `authClient`: in Nuxt, the Auth Definition's `basePath` below `app.baseURL`.
 * During Nuxt server rendering, a call such as `listSessions()` reaches the app in-process with the visitor's cookie.
 */
export const createAuthClient: typeof createBetterAuthClient = <Option extends BetterAuthClientOptions>(options?: Option) => createLazyAuthClient(() => withDefaultBasePath(options), () => options)

/**
 * The options with ViteHub's default `basePath` when they set none: in Nuxt, the Auth Definition's `basePath` below
 * `app.baseURL`. Read when Better Auth loads, after the Nuxt module set it.
 */
function withDefaultBasePath<Option extends BetterAuthClientOptions>(options: Option | undefined): Option {
  // SAFETY: `basePath` is a Better Auth client option, so adding it changes no type of the client.
  return { basePath: defaultBasePath ?? resolveAuthMountPath("/api/auth"), ...options } as Option
}

/**
 * The client of `createAuthClient()`. It runs `resolveOptions` when it loads Better Auth. `knownOptions` returns the
 * options known before the load, such as `sessionOptions`, without loading anything.
 */
function createLazyAuthClient<Option extends BetterAuthClientOptions>(resolveOptions: () => Option | undefined | Promise<Option | undefined>, knownOptions: () => Option | undefined = () => undefined): VueAuthClient<Option> {
  let loaded: Promise<VueAuthClient<Option>> | undefined
  let betterAuth: VueAuthClient<Option> | undefined
  // Run when Better Auth loads, before the first call runs, such as the session store that follows this client.
  const onLoad = new Set<(client: VueAuthClient<Option>) => void>()
  const load = () => (loaded ??= Promise.all([import("better-auth/vue"), resolveOptions()]).then(([module, options]) => {
    betterAuth = module.createAuthClient(options)
    for (const run of onLoad) run(betterAuth)
    onLoad.clear()
    return betterAuth
  }).catch((error: unknown) => {
    // A failed load, such as a chunk that a flaky network did not deliver, lets the next call try again.
    loaded = undefined
    throw error
  }))
  const whenLoaded = (run: (client: VueAuthClient<Option>) => void) => {
    if (betterAuth) run(betterAuth)
    else onLoad.add(run)
  }
  // On the server, each request has its own Better Auth client, so a call carries the cookie of its own request only.
  const requestClients = new WeakMap<object, Promise<VueAuthClient<Option>>>()

  /**
   * Better Auth's client for a call. On the server, during a request, it calls the app in-process with the visitor's
   * cookie. A client with its own `baseURL` or `customFetchImpl` keeps them. Call it before the caller's first `await`,
   * because only the caller's frame knows the request.
   */
  function loadForCall(): Promise<VueAuthClient<Option>> {
    const request = "window" in globalThis ? undefined : requestFetchResolver?.()
    if (!request) return load()
    let client = requestClients.get(request.request)
    if (!client) {
      client = Promise.all([import("better-auth/vue"), resolveOptions()]).then(([module, options]) => {
        if (options?.baseURL || options?.fetchOptions?.customFetchImpl) return load()
        // SAFETY: the same options with the origin and the fetch of the request, which change no type of the client.
        const requestOptions = { ...options, baseURL: request.origin, fetchOptions: { ...options?.fetchOptions, customFetchImpl: request.fetch } } as Option
        return module.createAuthClient(requestOptions)
      }).catch((error: unknown) => {
        requestClients.delete(request.request)
        throw error
      })
      requestClients.set(request.request, client)
    }
    return client
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
        if (key === LOAD && !path.length) return loadForCall
        if (key === ON_LOAD && !path.length) return whenLoaded
        if (key === OPTIONS && !path.length) return knownOptions()
        // Like Better Auth's own client: no symbols, and never a thenable.
        if (typeof key !== "string" || key === "then" || key === "catch" || key === "finally") return undefined
        if (!path.length && /^use[A-Z]/.test(key)) return (...args: unknown[]) => hook(key, args)
        return call([...path, key])
      },
      async apply(_, __, args) {
        const client = await loadForCall()
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
  /**
   * Sets the session that the server read for the request, if it is known now and nothing settled the state yet. With
   * `read` on the server, it starts the session read of the request if nobody started it yet.
   */
  seed: (read: boolean) => void
  /** On the server, the session read in flight while the state is pending, so a component's render can wait for it. */
  serverRead: () => Promise<unknown> | undefined
  /**
   * Sets the session to `null` at once, such as after a sign-out, also in Better Auth's session atom of `loaded`. A read
   * that started before it cannot write its answer, and the next read does not share it.
   */
  clear: (loaded: object) => void
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
  const instance = getCurrentInstance()
  // On the server, only a component can make the render wait, so only a component starts the session read.
  const read = !browser && Boolean(instance)
  const owner = browser ? browserOwner : app ?? instance?.appContext.app
  if (!owner) return createSessionStore(client, undefined, read)
  let byOwner = stores.get(client)
  if (!byOwner) stores.set(client, byOwner = new WeakMap())
  let store = byOwner.get(owner)
  if (!store) byOwner.set(owner, store = createSessionStore(client, app, read))
  // A store made before the session was known, such as at module scope, takes it from the first caller that knows it.
  else store.seed(read)
  store.hold(getCurrentScope())
  // The read settles the state itself: Vue runs `onServerPrefetch` only after an async setup ends, and that setup can
  // wait for the session. The render of each component that uses the session waits for the same read.
  const serverRead = read ? store.serverRead() : undefined
  if (serverRead) onServerPrefetch(() => serverRead)
  return store
}

function createSessionStore(client: object, app: NuxtApp | undefined, initialRead: boolean): SessionStore {
  const browser = "window" in globalThis
  const scope = effectScope(true)
  const settled = (data: unknown): SessionState => ({ data, error: null, isPending: false, isRefetching: false, refetch })
  const state = shallowRef<SessionState>(pendingState(refetch))
  let seeded = false
  let reading: Promise<unknown> | undefined
  // The server's session read of the request, once a caller started it or found it in flight.
  let serverReading: Promise<unknown> | undefined
  // The number of times `clear()` ran. A read that started before the last one cannot write its answer.
  let generation = 0
  // The generation when Better Auth's session atom started its last read.
  let atomGeneration = 0
  // Better Auth's session ref, which follows its session atom, once its client has loaded in the browser.
  let atom: Readonly<Ref<SessionState>> | undefined
  // Stops the wait for the session signal of a client that had loaded before the store. See `followSignal()`.
  let stopSignal: (() => void) | undefined
  // The browser's wait for a change of the session, and the number of scopes that keep it.
  let stopWaking: (() => void) | undefined
  let holders = 0

  async function refetch(query?: SessionQuery): Promise<void> {
    await read(query)
  }

  /** Settles the state with the server's session. A promise of it, such as a read still in flight, is the read. */
  function seed(read: boolean): void {
    if (seeded) return
    const value = sessionSeedResolver?.(read)
    if (value === undefined) return
    seeded = true
    if (!(value instanceof Promise)) {
      if (state.value.isPending) state.value = settled(value)
      return
    }
    serverReading = reading ??= share(value.then((session: unknown) => {
      if (session !== undefined && state.value.isPending) state.value = settled(session)
      return session ?? null
    }))
  }

  function serverRead(): Promise<unknown> | undefined {
    return !browser && state.value.isPending ? serverReading : undefined
  }

  /** Makes `read` the read that callers share, until it ends or `clear()` runs. */
  function share(read: Promise<unknown>): Promise<unknown> {
    const shared: Promise<unknown> = read.finally(() => {
      if (reading === shared) reading = undefined
    })
    return shared
  }

  /**
   * Follows Better Auth's session atom with one watcher. It runs when Better Auth loads, before the first call of the
   * client runs, so the session signal of that call, such as after `signOut()`, reaches the state.
   */
  function connect(loaded: object): Readonly<Ref<SessionState>> {
    if (atom) return atom
    stopWaking?.()
    stopWaking = undefined
    stopSignal?.()
    stopSignal = undefined
    // Start Better Auth's session with the server's, so a read that fails keeps it, as it does after a first read.
    const hydrateSession: unknown = Reflect.get(loaded, "hydrateSession")
    if (seeded && state.value.data && typeof hydrateSession === "function") hydrateSession.call(loaded, state.value.data)
    atom = scope.run(() => {
      // SAFETY: Better Auth's `useSession()` without an argument returns the ref of its session atom.
      const ref = (Reflect.get(loaded, "useSession") as () => Readonly<Ref<SessionState>>)()
      watch(ref, (value, old) => {
        // Better Auth sets `isRefetching` when it starts a read, and cancels the read before it.
        if (value.isRefetching && !old?.isRefetching) atomGeneration = generation
        // The answer of a read from before `clear()`. Remove it from Better Auth's atom too, so no later read starts with it.
        if (atomGeneration !== generation) {
          if (!value.isRefetching && value.data) clearAtom(loaded)
          return
        }
        // Better Auth starts each read with no data as pending. Once the state is settled, keep it until the read answers.
        if (!state.value.isPending && isPendingWithoutData(value)) return
        state.value = value
      }, { immediate: true, flush: "sync" })
      return ref
    })!
    return atom
  }

  /**
   * Waits for the session signal of a client that loaded before the store, such as one from `loadAuthClient()`, and then
   * follows its session atom. Better Auth sends the signal after a call that changes the session, such as a sign-in.
   * Waiting costs no read.
   */
  function followSignal(loaded: object): void {
    const signal = storeAtom<SessionSignal>(loaded, "$sessionSignal")
    if (!signal) {
      connect(loaded)
      return
    }
    stopSignal = signal.listen(() => void connect(loaded))
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
      const started = generation
      const session: unknown = await (app ? app.runWithContext(() => sessionSeedResolver?.(true)) : sessionSeedResolver?.(true))
      if (started !== generation) return state.value.data
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
    return reading ??= share(fetchSession())
  }

  function clear(loaded: object): void {
    generation++
    reading = undefined
    clearAtom(loaded)
    state.value = settled(null)
  }

  seed(initialRead)
  if (browser) {
    // Any load of the client, such as for a call, follows Better Auth before the call runs.
    const whenLoaded = Reflect.get(client, ON_LOAD) as ((run: (loaded: object) => void) => void) | undefined
    if (whenLoaded) whenLoaded(connect)
    // A client that loaded before the store, such as one from `better-auth/vue`, makes its calls without the store.
    else if (seeded && !state.value.isPending) followSignal(client)
    // Better Auth reads the session when its atom first mounts. The server read it for this page a moment ago, so a
    // store with the server's session waits until the session can change. An unknown session loads Better Auth at once.
    if (!seeded || state.value.isPending) void follow()
  }
  return { state, read, seed, serverRead, clear, hold, scope }
}

type SessionAtom = { get(): object, set(value: object): void }
type SessionSignal = { listen(listener: () => void): () => void }

/**
 * An atom of Better Auth's `$store` of a loaded client, such as `session` or `$sessionSignal`. Better Auth answers
 * `$store` and `atoms` with path proxies, and a missing atom with a function.
 */
function storeAtom<Atom>(loaded: object, name: string): Atom | undefined {
  const value: unknown = Reflect.get(Object(Reflect.get(Object(Reflect.get(loaded, "$store")), "atoms")), name)
  // SAFETY: an object in Better Auth's `$store.atoms` is a nanostores atom.
  return typeof value === "object" && value !== null ? value as Atom : undefined
}

/** Sets Better Auth's session atom of `loaded` to no session, settled. */
function clearAtom(loaded: object): void {
  const session = storeAtom<SessionAtom>(loaded, "session")
  session?.set({ ...session.get(), data: null, error: null, isPending: false, isRefetching: false })
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

/**
 * Better Auth's own Vue client behind one that `createAuthClient()` returned, once it has loaded. During Nuxt server
 * rendering, it is the client of the current request.
 */
export async function loadAuthClient<Client extends AuthClientLike>(client: Client): Promise<Client> {
  const load = Reflect.get(client, LOAD) as (() => Promise<Client>) | undefined
  return load ? await load() : client
}

/**
 * The options of the app's Auth client, such as Better Auth's client plugins. Export them from `app/auth.client.ts` in
 * a Nuxt app, or from `auth.client.ts` in the Vite root, and the default client, `useUserSession()`, and the Nuxt page
 * guard use them.
 */
export function defineAuthClient<Option extends BetterAuthClientOptions>(options: Option): Option {
  return options
}

declare global {
  namespace ViteHub {
    /** Generated declarations set `client` to the type of the options in the app's `auth.client.ts`. */
    interface AuthRegistry {}
  }
}

/** The client options that generated declarations register from the app's `auth.client.ts`. Without one, none. */
type RegisteredClientOptions<TRegistry> = TRegistry extends { client: infer TOptions }
  // An `any` type, such as from a file that the app's tsconfig cannot resolve, keeps the plain client.
  ? 0 extends 1 & TOptions ? {} : TOptions extends BetterAuthClientOptions ? TOptions : {}
  : {}

/** The fields that a server plugin's `schema` adds to one table. A plugin without a `schema`, such as `bearer()`, adds none. */
type ServerPluginTableFields<TSchema, TTable extends "session" | "user"> = TSchema extends { [Key in TTable]: { fields: infer TFields extends Record<string, unknown> } }
  ? TFields
  : {}

/**
 * The endpoints of a server plugin that change the session response, such as the `getSession` of `customSession()`.
 * Better Auth marks them with `CUSTOM_SESSION`. The client keeps no other plugin endpoint.
 */
type ServerPluginSessionEndpoints<TEndpoints> = {
  [Key in keyof TEndpoints as TEndpoints[Key] extends { options: { metadata: { CUSTOM_SESSION: boolean } } } ? Key : never]: TEndpoints[Key]
}

/**
 * A type-only client plugin with the user and session fields of one server plugin, such as the `role` of `admin()`,
 * and the session response of `customSession()`. It keeps only these, so every server plugin gives a valid client plugin.
 */
type ServerPluginFields<TPlugin> = TPlugin extends { id: infer Id extends string, schema?: infer Schema, endpoints?: infer Endpoints }
  ? {
      id: Id
      $InferServerPlugin: {
        endpoints: ServerPluginSessionEndpoints<Endpoints>
        schema: { session: { fields: ServerPluginTableFields<Schema, "session"> }, user: { fields: ServerPluginTableFields<Schema, "user"> } }
      }
    }
  : never

/**
 * Client options with type-only plugins: Better Auth's `inferAdditionalFields()` for `user.additionalFields` and
 * `session.additionalFields`, and the fields of each server plugin.
 */
type ServerFieldsClientOptions<TAuth extends { options: { plugins?: readonly unknown[] } }> = {
  plugins: Array<ReturnType<typeof inferAdditionalFields<TAuth>> | ServerPluginFields<NonNullable<TAuth["options"]["plugins"]>[number]>>
}

/** The plugins of client options, such as the `adminClient()` of `auth.client.ts`. */
type ClientOptionsPlugins<TOptions> = TOptions extends { plugins?: infer TPlugins } ? TPlugins extends readonly (infer TPlugin)[] ? TPlugin : never : never

/** The type-only plugins with the fields of the registered Auth Definition and its server plugins. Without one, none. */
type RegisteredServerFieldsPlugins<TRegistry> = TRegistry extends { definition: infer TDefinition extends AuthDefinition }
  // An `any` Definition, such as from a `server/auth.ts` that the app's tsconfig cannot resolve, keeps the plain fields.
  ? 0 extends 1 & TDefinition ? never : ServerFieldsClientOptions<AuthFor<TDefinition>>["plugins"][number]
  : never

/**
 * The type of the default client: Better Auth's Vue client with the options of the app's `auth.client.ts`. Generated
 * declarations also register the app's Auth Definition, so `user` and `session` have the fields that the Definition
 * and its plugins add. Without them, it has the plain Better Auth fields.
 */
export type RegisteredAuthClient<TRegistry = ViteHub.AuthRegistry> = ServerFieldsClient<
  Omit<RegisteredClientOptions<TRegistry>, "plugins"> & {
    plugins: Array<ClientOptionsPlugins<RegisteredClientOptions<TRegistry>> | RegisteredServerFieldsPlugins<TRegistry>>
  }
>

/** A client that Better Auth cannot type with these options keeps the plain fields, so `user` never becomes `never`. */
type ServerFieldsClient<TOptions> = TOptions extends BetterAuthClientOptions ? VueAuthClient<TOptions> : VueAuthClient<{}>

/**
 * The client that the composables and the Nuxt page guard share. On first use, it loads `better-auth/vue` and the app's
 * `auth.client.ts` together, and the options of that file replace the defaults. In Nuxt, the default `basePath` is the
 * Auth Definition's `basePath` below the `app.baseURL` of the page, also when `NUXT_APP_BASE_URL` sets it at runtime.
 */
// SAFETY: `RegisteredAuthClient` has the options of the same `auth.client.ts`, from the generated registry. Its other
// plugins change only types. Better Auth sends the same requests without them.
export const authClient = createLazyAuthClient(async () => {
  const { default: options } = await import("#vitehub/auth/client")
  return withDefaultBasePath(options)
}) as RegisteredAuthClient

/** Provide the app's configured client to Auth composables and `<AuthPermission>` in descendant components. */
export function provideAuthClient(client: AuthClientLike): void {
  provide(authClientKey, client)
}

export function useAuthClient(): typeof authClient {
  const instance = getCurrentInstance()
  const client = instance ? inject(authClientKey, undefined) : undefined
  const nuxtApp = nuxtAppResolver?.() || instance?.appContext.config.globalProperties.$nuxt as NuxtApp | undefined
  // SAFETY: the configured client uses the app's Auth Definition, which supplies `RegisteredAuthClient`'s types.
  return (client ?? nuxtApp?.$vitehubAuthClient ?? authClient) as typeof authClient
}

export interface AuthSessionState<Client extends AuthClientLike = typeof authClient> {
  data: Client["$Infer"]["Session"] | null
  error: BetterFetchError | null
  isPending: boolean
  isRefetching: boolean
  refetch: (queryParams?: { query?: SessionQueryParams }) => Promise<void>
}

type AuthSessionRef<Client extends AuthClientLike = typeof authClient> = DeepReadonly<Ref<AuthSessionState<Client>>>

/**
 * The session of `client`. Every call for the same client in the same app returns the same ref, so a list of
 * components that call it costs one watcher. In Nuxt, the page guard reads the session into the same ref.
 */
export function useSession<Client extends AuthClientLike = typeof authClient>(client: Client = useAuthClient() as Client): AuthSessionRef<Client> {
  // SAFETY: the store holds the state of Better Auth's `useSession()` for this client.
  return sessionStore(client).state as unknown as AuthSessionRef<Client>
}

type ClientSession<Client extends AuthClientLike> = Client["$Infer"]["Session"]

/** Better Auth's `signOut()` of `Client`. */
type ClientSignOut<Client extends AuthClientLike> = Extract<Client["signOut"], (...args: never) => unknown>

/** The parameters of Better Auth's `signOut()` of `Client`. */
type SignOutParameters<Client extends AuthClientLike> = Parameters<ClientSignOut<Client>>

/** The result of Better Auth's `signOut()` of `Client`. */
type SignOutResult<Client extends AuthClientLike> = ReturnType<ClientSignOut<Client>>

/** The options of `signOut()` from `useUserSession()`: the options of Better Auth's `signOut()`, and `redirectTo`. */
export type SignOutOptions<Client extends AuthClientLike = typeof authClient> = NonNullable<SignOutParameters<Client>[0]> & {
  /**
   * The page to open after the sign-out. Without it, in Nuxt, a page that only signed-in visitors may open sends the
   * visitor to the login page, as its page guard does.
   */
  redirectTo?: string
}

export interface UserSession<Client extends AuthClientLike = typeof authClient> {
  /** The Auth client of this session, with the endpoints of its client plugins, such as `client.admin.listUsers()`. */
  client: Client
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
   * result. When the sign-out fails, the session and the page stay. Better Auth gets `fetchOptions`, as its own
   * `signOut()` does.
   */
  signOut: (options?: SignOutOptions<Client>, fetchOptions?: SignOutParameters<Client>[1]) => SignOutResult<Client>
  signUp: Client["signUp"]
  /** End the impersonation session and restore the administrator's own session. */
  stopImpersonating: () => Promise<void>
  user: ComputedRef<ClientSession<Client>["user"] | null>
}

/**
 * The current user and session of `client`, with sign-in and sign-out actions. Every call for the same client in the
 * same app returns the same object, so a list of components that call it costs nothing more.
 */
export function useUserSession<Client extends AuthClientLike = typeof authClient>(client: Client = useAuthClient() as Client): UserSession<Client> {
  const store = sessionStore(client)
  // SAFETY: the store makes this object once, for this client.
  return (store.userSession ??= store.scope.run(() => createUserSession(client, store))) as UserSession<Client>
}

function createUserSession<Client extends AuthClientLike>(client: Client, store: SessionStore): UserSession<Client> {
  // SAFETY: the store holds the state of Better Auth's `useSession()` for this client.
  const state = store.state as unknown as AuthSessionRef<Client>
  // SAFETY: `read()` returns the session of this client, or `null`.
  const refresh = store.read as () => Promise<ClientSession<Client> | null>
  return {
    client,
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
    signOut: (options, ...fetchOptions) => signOut(client, store, options, fetchOptions) as SignOutResult<Client>,
    signUp: client.signUp,
    async stopImpersonating() {
      // The path works without Better Auth's `adminClient()` plugin on the client.
      await client.$fetch("/admin/stop-impersonating", { method: "POST", body: {}, throw: true })
      await refresh()
    },
    user: computed(() => state.value.data?.user ?? null),
  }
}

async function signOut(client: AuthClientLike, store: SessionStore, options: { redirectTo?: string } = {}, fetchOptions: unknown[] = []): Promise<unknown> {
  const { redirectTo, ...betterAuthOptions } = options
  // SAFETY: every Better Auth client has `signOut()`, which answers with a promise.
  const result = await (client.signOut as (...args: unknown[]) => Promise<unknown>)(betterAuthOptions, ...fetchOptions)
  // Better Auth returns `{ data, error }`, and only the data with `fetchOptions.throw`, which throws on an error.
  const answer = typeof result === "object" && result !== null && "data" in result && "error" in result ? result : { data: result, error: null }
  if (answer.error) return result
  if (!("window" in globalThis)) return result
  // Better Auth reads the session again after a sign-out, and the page shows the user until it answers. Its session
  // atom starts that read from `null`, so the read cannot show the user again. Every component shares the store, so
  // they all show the sign-out at once.
  store.clear(await loadAuthClient(client as VueAuthClient<{}>))
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

/** The part of the session state that a rule check reads. */
type AbilitySessionState = { isPending: boolean, data: { user: object } | null }

/** The refusal of a rule for the visitor: `undefined` while the session is unknown, `null` when the rule allows. */
function abilityRefusal(state: AbilitySessionState, name: string, args: unknown[]): AbilityCheckRefusal | null | undefined {
  if (state.isPending) return undefined
  return checkAbility(abilities, state.data?.user ?? null, name, args)
}

/**
 * The user that `authorize()` checks. The server uses the session it read for the request. While Nuxt hydrates, the
 * browser uses the same session, so it decides as the server did. Otherwise the browser asks the client of
 * `useAbility()`, because a sign-in or sign-out in the tab makes the server's session old. In Nuxt, that is the client of
 * the page guard, at the configured Auth `basePath` below `app.baseURL`.
 */
async function authorizedUser(client: Pick<typeof authClient, "getSession">, state: Readonly<Ref<AbilitySessionState>>): Promise<object | null> {
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
export function useAbility(client: AuthClientLike = useAuthClient()): Ability {
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

/** The rule arguments use the same tuple as the server check. */
type PermissionArguments<Args extends unknown[]> = [] extends Args ? { args?: Args } : { args: Args }

export type AuthPermissionProps<Name extends AbilityName> = { check: Name, pending?: boolean } & PermissionArguments<AbilityArgs<Name>>

export interface AuthPermissionSlots<Name extends AbilityName> {
  default?: () => VNode[]
  allowed?: () => VNode[]
  denied?: (refusal: AbilityRefusal<Name>) => VNode[]
}

export type AuthPermissionComponent = <const Name extends AbilityName>(props: AuthPermissionProps<Name>) => VNode & {
  __ctx?: { props: AuthPermissionProps<Name>, slots: AuthPermissionSlots<Name> }
}

/** Render the allowed or denied slot. The default slot is shorthand for allowed. */
// SAFETY: the runtime props implement the generic component contract used by vue-tsc.
export const AuthPermission: AuthPermissionComponent = defineComponent({
  name: "AuthPermission",
  props: {
    check: { type: String, required: true },
    args: { type: Array, default: () => [] },
    pending: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    const state = useSession()
    const refusal = computed(() => props.pending ? undefined : abilityRefusal(state.value, props.check, props.args))
    return () => {
      const value = refusal.value
      if (value === undefined) return null
      if (value === null) return (slots.allowed ?? slots.default)?.()
      return slots.denied?.({ code: value.code, details: value.details })
    }
  },
}) as unknown as AuthPermissionComponent
