import type { Driver, GetKeysOptions, TransactionOptions } from "unstorage"

import type { ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "../types.ts"
import { resolveRuntimeKVOptions } from "./upstash.ts"

type DriverFactory = (options: object) => Driver

const driverLoaders = {
  "cloudflare-kv-binding": () => import("unstorage/drivers/cloudflare-kv-binding"),
  "fs-lite": () => import("unstorage/drivers/fs-lite"),
  "upstash": () => import("unstorage/drivers/upstash"),
} satisfies Record<ResolvedKVStoreConfig["driver"], () => Promise<{ default: DriverFactory }>>

async function loadDriverFactory(driver: ResolvedKVStoreConfig["driver"]) {
  const module = await driverLoaders[driver]()
  return module.default
}

async function createKVRuntimeDriver(
  config: ResolvedKVStoreConfig,
): Promise<Driver> {
  const createDriver = await loadDriverFactory(config.driver)
  return createDriver(config)
}

export function createLazyKVRuntimeDriver(
  config: ResolvedKVModuleOptions,
): Driver {
  let driverPromise: Promise<Driver> | undefined

  const resolveDriver = () => driverPromise ||= (async () => {
    const resolved = resolveRuntimeKVOptions(config)
    if (!resolved) {
      throw new Error("KV runtime is disabled.")
    }

    return createKVRuntimeDriver(resolved.store)
  })()

  return {
    name: `lazy:${config.store.driver}`,
    options: config.store,
    hasItem: async (key: string, options: TransactionOptions = {}) => {
      return (await resolveDriver()).hasItem(key, options)
    },
    getItem: async (key: string, options: TransactionOptions = {}) => {
      return (await resolveDriver()).getItem(key, options)
    },
    getItems: async (items, commonOptions = {}) => {
      const driver = await resolveDriver()
      return driver.getItems?.(items, commonOptions) ?? []
    },
    getItemRaw: async (key: string, options: TransactionOptions = {}) => {
      const driver = await resolveDriver()
      return driver.getItemRaw?.(key, options) ?? null
    },
    setItem: async (key: string, value: string, options: TransactionOptions = {}) => {
      const driver = await resolveDriver()
      return driver.setItem?.(key, value, options)
    },
    setItems: async (items, commonOptions = {}) => {
      const driver = await resolveDriver()
      return driver.setItems?.(items, commonOptions)
    },
    setItemRaw: async (key: string, value: unknown, options: TransactionOptions = {}) => {
      const driver = await resolveDriver()
      return driver.setItemRaw?.(key, value, options)
    },
    removeItem: async (key: string, options: TransactionOptions = {}) => {
      const driver = await resolveDriver()
      return driver.removeItem?.(key, options)
    },
    getMeta: async (key: string, options: TransactionOptions = {}) => {
      const driver = await resolveDriver()
      return driver.getMeta?.(key, options) ?? null
    },
    getKeys: async (base: string, options: GetKeysOptions = {}) => {
      return (await resolveDriver()).getKeys(base, options)
    },
    clear: async (base: string, options: TransactionOptions = {}) => {
      const driver = await resolveDriver()
      return driver.clear?.(base, options)
    },
    dispose: async () => {
      if (!driverPromise) {
        return
      }

      const driver = await driverPromise
      return driver.dispose?.()
    },
  }
}
