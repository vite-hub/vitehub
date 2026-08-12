import type { Driver } from "unstorage"

import type { ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "../types.ts"
import { resolveRuntimeKVOptions } from "./upstash.ts"

type AnyRecord = Record<PropertyKey, unknown>

const lazyDriverMethods = new Set<PropertyKey>([
  "clear",
  "getItem",
  "getKeys",
  "hasItem",
  "removeItem",
  "setItem",
])

const lazyOptionalDriverMethods: Record<ResolvedKVStoreConfig["driver"], Set<PropertyKey>> = {
  "cloudflare-kv-binding": new Set(),
  "deno-kv": new Set(),
  "fs-lite": new Set(["getItemRaw", "getMeta", "setItemRaw"]),
  "upstash": new Set(["getItems"]),
}

async function createRuntimeDriver(store: ResolvedKVStoreConfig): Promise<Driver> {
  switch (store.driver) {
    case "cloudflare-kv-binding": {
      const { default: factory } = await import("unstorage/drivers/cloudflare-kv-binding")
      return factory(store)
    }
    case "deno-kv": {
      const { default: factory } = await import("./deno-kv.ts")
      return factory(store)
    }
    case "fs-lite": {
      const { createFsLiteKVRuntimeDriver } = await import("./fs-lite.ts")
      return createFsLiteKVRuntimeDriver(store)
    }
    case "upstash": {
      const { default: factory } = await import("@vite-hub/kv/runtime/upstash-driver")
      return factory(store)
    }
  }
}

export function createLazyKVRuntimeDriver(config: ResolvedKVModuleOptions): Driver {
  let driverPromise: Promise<Driver> | undefined

  const resolve = () => driverPromise ||= (async () => {
    const runtime = resolveRuntimeKVOptions(config)
    if (!runtime) throw new Error("KV runtime is disabled.")
    return createRuntimeDriver(runtime.store)
  })()

  const target = { name: `lazy:${config.store.driver}`, options: config.store } as AnyRecord

  return new Proxy(target as unknown as Driver, {
    get(t, prop) {
      const own = (t as unknown as AnyRecord)[prop]
      if (own !== undefined) return own
      if (prop === "dispose") {
        return async () => {
          if (!driverPromise) return
          const driver = await driverPromise as unknown as AnyRecord
          const fn = driver.dispose as ((this: unknown) => unknown) | undefined
          return fn?.call(driver)
        }
      }
      const optionalMethods = lazyOptionalDriverMethods[config.store.driver]
      if (!lazyDriverMethods.has(prop) && !optionalMethods.has(prop)) return undefined
      return async (...args: unknown[]) => {
        const driver = await resolve() as unknown as AnyRecord
        const method = driver[prop] as ((this: unknown, ...args: unknown[]) => unknown) | undefined
        return method?.apply(driver, args)
      }
    },
  })
}
