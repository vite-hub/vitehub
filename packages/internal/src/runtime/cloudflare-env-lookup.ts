// Reads the Cloudflare bindings without importing `node:async_hooks`, so browser-safe entries can bundle it.
// `cloudflare-env.ts` owns the AsyncLocalStorage store and the setters.

export type CloudflareWorkerEnv = Record<string, unknown>

/** The key of the AsyncLocalStorage store on `globalThis`. Every bundled copy of this module shares the store. */
export const activeEnvStorageKey: unique symbol = Symbol.for("vitehub.cloudflare.env-storage")

interface ActiveEnvStore {
  getStore(): { env: CloudflareWorkerEnv | undefined } | undefined
}

let activeEnv: CloudflareWorkerEnv | undefined

/** The env that `setActiveCloudflareEnv()` installed in this bundled copy, outside a scoped run. */
export function getInstalledCloudflareEnv(): CloudflareWorkerEnv | undefined {
  return activeEnv
}

export function setInstalledCloudflareEnv(env: CloudflareWorkerEnv | undefined): void {
  activeEnv = env
}

/** The store of the current `runWithActiveCloudflareEnv()` call, or undefined outside one. */
export function getScopedCloudflareEnv(): { env: CloudflareWorkerEnv | undefined } | undefined {
  // SAFETY: cloudflare-env.ts stores an AsyncLocalStorage of this shape under the shared symbol.
  const storage = (globalThis as typeof globalThis & Record<symbol, ActiveEnvStore | undefined>)[activeEnvStorageKey]
  return storage?.getStore()
}

export function getActiveCloudflareEnv(): CloudflareWorkerEnv | undefined {
  const scoped = getScopedCloudflareEnv()
  if (scoped) return scoped.env
  const host = globalThis as { __env__?: CloudflareWorkerEnv }
  // Nitro updates __env__ for the current Worker request. Prefer that ambient
  // binding over the process fallback, which may belong to an earlier request.
  return Object.hasOwn(host, "__env__") && host.__env__ !== undefined ? host.__env__ : activeEnv
}

export function ownValue(value: unknown, key: PropertyKey): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function") || !Object.hasOwn(value, key)) return undefined
  return Reflect.get(value, key)
}

export function ownObject(value: unknown): Record<PropertyKey, unknown> | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? value as Record<PropertyKey, unknown>
    : undefined
}

/** The objects where H3 and Nitro hosts put Cloudflare `env` and `context`, in lookup order. */
export function cloudflareOwners(target: Record<PropertyKey, unknown> | undefined): Array<Record<PropertyKey, unknown> | undefined> {
  const context = ownObject(ownValue(target, "context"))
  const platform = ownObject(ownValue(context, "_platform"))
  const req = ownObject(ownValue(target, "req"))
  return [
    ownObject(ownValue(context, "cloudflare")),
    ownObject(ownValue(platform, "cloudflare")),
    ownObject(ownValue(ownObject(ownValue(req, "runtime")), "cloudflare")),
  ]
}

export function getCloudflareEnv(event: unknown, options: { fallback?: boolean } = {}): CloudflareWorkerEnv | undefined {
  const target = ownObject(event)
  for (const candidate of [ownValue(target, "env"), ...cloudflareOwners(target).map(owner => ownValue(owner, "env"))]) {
    if (candidate) return candidate as CloudflareWorkerEnv
  }
  return options.fallback === false ? undefined : getActiveCloudflareEnv()
}
