import type { Driver } from "unstorage"

import type { KVListOptions, KVListPage, ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "../types.ts"
import { resolveRuntimeKVOptions } from "./upstash.ts"

type AnyRecord = Record<PropertyKey, unknown>

const lazyDriverMethods = new Set<PropertyKey>([
  "clear",
  "getItem",
  "getKeys",
  "hasItem",
  "listKeys",
  "removeItem",
  "setItem",
])

export type KVRuntimeDriver = Driver & Record<string, unknown> & {
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This mirrors unstorage's caller-typed read contract at the internal driver boundary.
  getAndDeleteItem?: <T = unknown>(key: string) => Promise<T | null>
  incrementItem?: (key: string, ttl: number) => Promise<number>
  listKeys: (options: KVListOptions) => Promise<KVListPage>
}

const lazyOptionalDriverMethods: Record<ResolvedKVStoreConfig["driver"], Set<PropertyKey>> = {
  "cloudflare-kv-binding": new Set(),
  "deno-kv": new Set(["getAndDeleteItem", "incrementItem"]),
  "fs-lite": new Set(["getItemRaw", "getMeta", "setItemRaw"]),
  "upstash": new Set(["getAndDeleteItem", "getItems", "incrementItem"]),
}

async function createRuntimeDriver(store: ResolvedKVStoreConfig): Promise<KVRuntimeDriver> {
  switch (store.driver) {
    case "cloudflare-kv-binding": {
      const { default: factory } = await import("./cloudflare-kv.ts")
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- This adapter accepts the resolved Cloudflare record and returns KVRuntimeDriver.
      // SAFETY: The discriminated configuration is resolved and the adapter installs every KVRuntimeDriver member.
      return factory(store as unknown as Record<string, unknown>) as KVRuntimeDriver
    }
    case "deno-kv": {
      const { default: factory } = await import("./deno-kv.ts")
      return factory(store)
    }
    case "fs-lite": {
      const { default: factory } = await import("./fs-lite.ts")
      return factory(store)
    }
    case "upstash": {
      const { default: factory } = await import("@vite-hub/kv/runtime/upstash-driver")
      return factory(store)
    }
  }
}

export function createLazyKVRuntimeDriver(config: ResolvedKVModuleOptions): KVRuntimeDriver {
  let driverPromise: Promise<Driver> | undefined

  const resolve = () => driverPromise ||= (async () => {
    const runtime = resolveRuntimeKVOptions(config)
    if (!runtime) throw new Error("KV runtime is disabled.")
    return createRuntimeDriver(runtime.store)
  })()

  // SAFETY: The proxy below supplies driver methods lazily and preserves these two concrete own properties.
  const target = { name: `lazy:${config.store.driver}`, options: config.store } as AnyRecord

  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- The proxy get trap supplies the complete KVRuntimeDriver contract.
  // SAFETY: The get trap forwards every required method to a resolved KVRuntimeDriver.
  return new Proxy(target as unknown as KVRuntimeDriver, {
    get(t, prop) {
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Proxy targets are accessed through the intentionally open internal record.
      // SAFETY: AnyRecord is the private representation used to inspect proxy properties.
      const own = (t as unknown as AnyRecord)[prop]
      if (own !== undefined) return own
      if (prop === "dispose") {
        return async () => {
          if (!driverPromise) return
          // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- The promise resolves only from createRuntimeDriver.
          // SAFETY: createRuntimeDriver returns the callable driver record inspected here.
          const driver = await driverPromise as unknown as AnyRecord
          // SAFETY: dispose is optional and invoked only when callable.
          const fn = driver.dispose as ((this: unknown) => unknown) | undefined
          return fn?.call(driver)
        }
      }
      const optionalMethods = lazyOptionalDriverMethods[config.store.driver]
      if (!lazyDriverMethods.has(prop) && !optionalMethods.has(prop)) return undefined
      return async (...args: unknown[]) => {
        // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- resolve returns a KVRuntimeDriver represented as a callable record.
        // SAFETY: createRuntimeDriver owns the resolved driver's methods.
        const driver = await resolve() as unknown as AnyRecord
        // SAFETY: The method name comes from the required or provider-supported method sets above.
        const method = driver[prop] as ((this: unknown, ...args: unknown[]) => unknown) | undefined
        return method?.apply(driver, args)
      }
    },
  })
}
