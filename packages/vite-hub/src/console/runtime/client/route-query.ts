import { onBeforeUnmount, ref, watch } from "vue"
import { isNavigationFailure, NavigationFailureType, useRoute, useRouter } from "vue-router"

import type { Ref } from "vue"
import type { LocationQuery, LocationQueryRaw, RouteLocationNormalizedLoaded, Router } from "vue-router"

// Page state in the URL, such as `?q=error&level=warn&entry=42`, so a reload, a shared link, or a new tab opens the same view.

/** One query parameter of a page. */
export interface ConsoleQueryParam<T> {
  /** The value without the parameter. A value equal to it leaves the URL. */
  default: T
  /**
   * `push` adds a history entry, so Back returns to the previous value. Use it for selections, tabs, and pages.
   * `replace` (the default) changes the current entry. Use it for search text, filters, and sort.
   */
  history?: "push" | "replace"
  /** Reads the URL text. `undefined` marks an invalid value, which reads as the default. */
  read: (text: string) => T | undefined
  /** Writes the value as URL text. The default is `String(value)`. Empty text leaves the URL. */
  write?(value: T): string
}

type ConsoleQueryParams = Record<string, ConsoleQueryParam<unknown>>
type ConsoleQueryValues<P extends ConsoleQueryParams> = { [K in keyof P]: P[K] extends ConsoleQueryParam<infer T> ? T : never }

/** The first text value of a query parameter. Empty and repeated-null values read as `undefined`. */
export function consoleQueryText(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  return String(first) === first && first ? first : undefined
}

/** Free text, such as a search. Surrounding spaces stay while someone types and leave the URL. */
export function queryText(options: { fallback?: string, history?: "push" | "replace" } = {}): ConsoleQueryParam<string> {
  return { default: options.fallback ?? "", history: options.history, read: text => text, write: value => value.trim() }
}

/** An optional id, such as the selected row. A selection adds a history entry unless `history` says otherwise. */
export function querySelection(options: { history?: "push" | "replace" } = {}): ConsoleQueryParam<string | undefined> {
  return { default: undefined, history: options.history ?? "push", read: text => text }
}

/** One of a fixed list of values, such as a tab or a level. */
export function queryChoice<const T extends string>(values: readonly T[], fallback: NoInfer<T>, options: { history?: "push" | "replace" } = {}): ConsoleQueryParam<T> {
  return { default: fallback, history: options.history, read: text => values.find(value => value === text) }
}

/** A whole number at or above `min`, such as a row offset. */
export function queryInteger(fallback: number, options: { history?: "push" | "replace", min?: number } = {}): ConsoleQueryParam<number> {
  const min = options.min ?? 0
  return {
    default: fallback,
    history: options.history,
    read: (text) => {
      const value = Number(text)
      return /^\d+$/.test(text) && Number.isSafeInteger(value) && value >= min ? value : undefined
    },
  }
}

/** A switch that is on with `=1`. */
export function queryFlag(options: { history?: "push" | "replace" } = {}): ConsoleQueryParam<boolean> {
  return { default: false, history: options.history, read: text => text === "1" || undefined, write: () => "1" }
}

function written(param: ConsoleQueryParam<unknown>, value: unknown): string | undefined {
  if (value === undefined || value === param.default) return undefined
  return (param.write ? param.write(value) : String(value)) || undefined
}

/** Reads the page state from a route query. Missing and invalid values read as their defaults. */
export function readConsoleQuery<P extends ConsoleQueryParams>(params: P, query: LocationQuery | Readonly<Record<string, unknown>>): ConsoleQueryValues<P> {
  // SAFETY: every key of `params` gets a value of its parameter type.
  return Object.fromEntries(Object.entries(params).map(([name, param]) => [name, readParam(param, query[name])])) as ConsoleQueryValues<P>
}

function readParam(param: ConsoleQueryParam<unknown>, value: unknown): unknown {
  const text = consoleQueryText(value)
  const read = text === undefined ? undefined : param.read(text)
  return read === undefined ? param.default : read
}

/** Writes the page state into a route query. Defaults leave the URL, and parameters that the page does not own stay. */
export function writeConsoleQuery<P extends ConsoleQueryParams>(params: P, values: Partial<ConsoleQueryValues<P>>, query: LocationQuery | LocationQueryRaw): LocationQueryRaw {
  const next: LocationQueryRaw = { ...query }
  for (const [name, param] of Object.entries(params)) {
    if (!(name in values)) continue
    const text = written(param, values[name])
    if (text === undefined) delete next[name]
    else next[name] = text
  }
  return next
}

// The query of the newest write in flight. Two parts of a page that write in one tick build on each other's query.
// A write that replaces a pending `push` pushes too.
const pendingWrites = new WeakMap<Router, { push: boolean, query: LocationQueryRaw }>()

/** True when the two queries hold the same page state. */
function sameState(params: ConsoleQueryParams, left: LocationQueryRaw, right: LocationQueryRaw): boolean {
  return Object.keys(params).every(name => consoleQueryText(left[name]) === consoleQueryText(right[name]))
}

/**
 * Binds page state to the URL. Each key of `params` is a query parameter name and becomes a ref.
 * Changing a ref writes the URL at once: `push` parameters add a history entry, the others replace it, so Back and
 * Forward walk selections and pages instead of keystrokes. A navigation that the page starts in the same tick wins
 * over this write, so include the state in its query. Back, Forward, and links change the refs and call `onRestore`
 * with the names that changed. `active` limits the binding to the routes of the page while it stays mounted across
 * other routes. Without a router, such as a component mounted on its own, the state stays in the refs.
 */
export function useConsoleQuery<P extends ConsoleQueryParams>(
  params: P,
  options: {
    active?: (route: RouteLocationNormalizedLoaded) => boolean
    onRestore?: (names: Array<keyof P & string>) => void
  } = {},
): { [K in keyof P]: Ref<ConsoleQueryValues<P>[K]> } {
  // `useRoute()` and `useRouter()` return `undefined` in an app without a router.
  const injectedRoute: RouteLocationNormalizedLoaded | undefined = useRoute()
  const injectedRouter: Router | undefined = useRouter()
  if (!injectedRoute || !injectedRouter) {
    // SAFETY: each ref starts at the default of its parameter.
    return Object.fromEntries(Object.entries(params).map(([name, param]) => [name, ref(param.default)])) as { [K in keyof P]: Ref<ConsoleQueryValues<P>[K]> }
  }
  const route: RouteLocationNormalizedLoaded = injectedRoute
  const router: Router = injectedRouter
  // By default the binding follows the route that mounted the page.
  const owner = route.name
  const isActive = () => options.active ? options.active(route) : route.name === owner
  const initial = readConsoleQuery(params, route.query)
  const refs: Record<string, Ref<unknown>> = Object.fromEntries(Object.keys(params).map(name => [name, ref(initial[name])]))
  // Writes in flight. The URL catches up with the refs when they finish, so it does not reset the refs before that.
  let writing = 0
  let disposed = false

  function values(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(refs).map(([name, value]) => [name, value.value]))
  }

  // Reads the URL into the refs. Values that write the same URL text, such as a search with a trailing space, stay.
  function restore(): void {
    if (disposed || writing || !isActive()) return
    const next = readConsoleQuery(params, route.query)
    const changed: string[] = []
    for (const [name, value] of Object.entries(refs)) {
      const param = params[name]!
      if (written(param, value.value) === written(param, next[name])) continue
      value.value = next[name]
      changed.push(name)
    }
    if (changed.length) options.onRestore?.(changed)
  }

  watch(Object.values(refs), () => {
    if (disposed || !isActive()) return
    const state = values()
    const pending = pendingWrites.get(router)
    const base = pending?.query ?? route.query
    // SAFETY: `state` has one value of its parameter type for each parameter.
    const query = writeConsoleQuery(params, state as Partial<ConsoleQueryValues<P>>, base)
    if (sameState(params, query, base)) return
    const current = readConsoleQuery(params, base)
    const push = Boolean(pending?.push) || Object.entries(params).some(([name, param]) => param.history === "push" && written(param, current[name]) !== written(param, state[name]))
    const write = { push, query }
    writing++
    pendingWrites.set(router, write)
    void (push ? router.push({ query }) : router.replace({ query })).then((failure) => {
      writing--
      if (pendingWrites.get(router) === write) pendingWrites.delete(router)
      // A guard stopped the navigation, so the URL keeps the previous state. A later navigation that replaced this
      // one brings its own query.
      if (isNavigationFailure(failure, NavigationFailureType.aborted)) restore()
    }, () => {
      writing--
      if (pendingWrites.get(router) === write) pendingWrites.delete(router)
      restore()
    })
  }, { flush: "sync" })

  watch(() => route.query, restore)

  onBeforeUnmount(() => {
    disposed = true
  })

  // SAFETY: `refs` has one ref for each parameter, created from its parameter type.
  return refs as { [K in keyof P]: Ref<ConsoleQueryValues<P>[K]> }
}
