import type { Driver } from "unstorage"

import type { ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "../types.ts"
import { resolveRuntimeKVOptions } from "./upstash.ts"

type DriverFactory = (options: object) => Driver
type AnyRecord = Record<PropertyKey, unknown>

const driverLoaders = {
  "cloudflare-kv-binding": () => import("unstorage/drivers/cloudflare-kv-binding"),
  "fs-lite": () => import("unstorage/drivers/fs-lite"),
  "upstash": () => import("unstorage/drivers/upstash"),
} satisfies Record<ResolvedKVStoreConfig["driver"], () => Promise<{ default: DriverFactory }>>

export function createLazyKVRuntimeDriver(config: ResolvedKVModuleOptions): Driver {
  let driverPromise: Promise<Driver> | undefined

  const resolve = () => driverPromise ||= (async () => {
    const runtime = resolveRuntimeKVOptions(config)
    if (!runtime) throw new Error("KV runtime is disabled.")
    const { default: factory } = await driverLoaders[runtime.store.driver]()
    return factory(runtime.store)
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
      return async (...args: unknown[]) => {
        const driver = await resolve() as unknown as AnyRecord
        const method = driver[prop] as ((this: unknown, ...args: unknown[]) => unknown) | undefined
        return method?.apply(driver, args)
      }
    },
  })
}
