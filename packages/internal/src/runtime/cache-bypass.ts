/**
 * A check that keeps the current request out of Nitro's cache. It runs synchronously inside the request, so it
 * usually reads request-scoped state such as an AsyncLocalStorage store.
 */
export type CacheBypassCheck = () => boolean

/**
 * `Symbol.for()` key of the shared check set. Every bundled copy of this module and the Nitro cache seam that
 * `nitroCacheBypass()` generates read the same set.
 */
export const cacheBypassKey = "vitehub.nitro.cache-bypass"

type CacheBypassGlobal = typeof globalThis & { [key: symbol]: Set<CacheBypassCheck> | undefined }

function checks(): Set<CacheBypassCheck> {
  const runtime: CacheBypassGlobal = globalThis
  return runtime[Symbol.for(cacheBypassKey)] ??= new Set()
}

/**
 * Bypass Nitro's response and function cache while `check` returns true: cached handlers, `cache`/`swr` route rules,
 * and cached functions then run without reading or writing an entry. Returns a function that removes the check.
 */
export function addCacheBypass(check: CacheBypassCheck): () => void {
  const registered = checks()
  registered.add(check)
  return () => {
    registered.delete(check)
  }
}

/** Whether a registered check asks the current request to bypass Nitro's cache. */
export function shouldBypassCache(): boolean {
  for (const check of checks()) {
    if (check()) return true
  }
  return false
}
