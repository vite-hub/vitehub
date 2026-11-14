import type { Driver, TransactionOptions } from "unstorage"

import type { KVAtomicOperation, KVDriver, KVDriverAtomicOperations, KVListOptions, KVListPage, ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "../types.ts"
import type { KVDatabases } from "./database.ts"
import { resolveRuntimeKVOptions } from "./upstash.ts"
import { kvErrorDiagnostics } from "../error-diagnostics.ts"
import { getItemsOneByOne, setItemsOneByOne } from "./batch.ts"

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
  validateBatch?: (items: Parameters<NonNullable<Driver["setItems"]>>[0], removals: string[], options?: TransactionOptions) => void | Promise<void>
  /** Deletes the key when it holds the serialized `expected` value. Resolves `true` when this call deleted it. */
  deleteIfEqualsItem?: (key: string, expected: string) => Promise<boolean>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- This mirrors unstorage's caller-typed read contract at the internal driver boundary.
  getAndDeleteItem?: <T = unknown>(key: string) => Promise<T | null>
  incrementItem?: (key: string, ttl: number) => Promise<number>
  listKeys: (options: KVListOptions) => Promise<KVListPage>
  /** Writes the serialized value only when the key is missing. Resolves `true` when this call wrote it. */
  setIfAbsentItem?: (key: string, value: string, ttl?: number) => Promise<boolean>
}

/** The driver method behind each atomic KV operation. */
const atomicDriverMethods = {
  deleteIfEquals: "deleteIfEqualsItem",
  getAndDelete: "getAndDeleteItem",
  increment: "incrementItem",
  setIfAbsent: "setIfAbsentItem",
} as const satisfies Record<KVAtomicOperation, keyof KVRuntimeDriver>

// The type requires exactly the operations that `KVDriverAtomicOperations` lists for each driver.
const driverAtomicOperations: { [Driver in KVDriver]: Record<KVDriverAtomicOperations[Driver], true> } = {
  "cloudflare-kv-binding": {},
  "database": { deleteIfEquals: true, getAndDelete: true, increment: true, setIfAbsent: true },
  "deno-kv": { setIfAbsent: true },
  "fs-lite": { setIfAbsent: true },
  "redis": { deleteIfEquals: true, getAndDelete: true, increment: true, setIfAbsent: true },
  "upstash": { deleteIfEquals: true, getAndDelete: true, increment: true, setIfAbsent: true },
}

/** Other optional unstorage methods that a driver has. */
const otherOptionalDriverMethods: Partial<Record<KVDriver, readonly string[]>> = {
  "cloudflare-kv-binding": ["validateBatch"],
  "fs-lite": ["getItemRaw", "getMeta", "setItemRaw"],
}

/** Batch methods. A driver without one gets a version that calls the single-key method for each key. */
const batchDriverMethods = new Set<PropertyKey>(["getItems", "setItems"])

const lazyOptionalDriverMethods = Object.fromEntries(Object.entries(driverAtomicOperations).map(([driver, operations]) => [
  driver,
  new Set<PropertyKey>([
    // SAFETY: The keys of each entry are atomic operations, as the type of `driverAtomicOperations` says.
    ...Object.keys(operations).map(operation => atomicDriverMethods[operation as KVAtomicOperation]),
    ...otherOptionalDriverMethods[driver as KVDriver] ?? [],
  ]),
])) as Record<KVDriver, Set<PropertyKey>>

/** Loads the databases of the app for the `database` driver. The generated KV config provides it when a store needs it. */
export type KVDatabasesLoader = () => Promise<KVDatabases>

async function createDatabaseDriver(store: Extract<ResolvedKVStoreConfig, { driver: "database" }>, loadDatabases: KVDatabasesLoader | undefined): Promise<KVRuntimeDriver> {
  const { default: factory, kvSqlClientFromDatabase } = await import("./database.ts")
  return factory(store, async () => {
    const entry = loadDatabases ? (await loadDatabases())[store.database] : undefined
    if (!entry) throw kvErrorDiagnostics.KV_DATABASE_UNAVAILABLE({ database: store.database, problem: "missing" })
    return kvSqlClientFromDatabase(entry.db, store.database)
  })
}

async function createRuntimeDriver(store: ResolvedKVStoreConfig, loadDatabases: KVDatabasesLoader | undefined): Promise<KVRuntimeDriver> {
  switch (store.driver) {
    case "cloudflare-kv-binding": {
      const { localBase } = store
      if (localBase) {
        const { default: factory } = await import("./cloudflare-kv-local.ts")
        return factory({ ...store, localBase })
      }
      const { default: factory } = await import("./cloudflare-kv.ts")
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- This adapter accepts the resolved Cloudflare record and returns KVRuntimeDriver.
      // SAFETY: The discriminated configuration is resolved and the adapter installs every KVRuntimeDriver member.
      return factory(store as unknown as Record<string, unknown>) as KVRuntimeDriver
    }
    case "database": return createDatabaseDriver(store, loadDatabases)
    case "deno-kv": {
      const { default: factory } = await import("./deno-kv.ts")
      return factory(store)
    }
    case "fs-lite": {
      const { default: factory } = await import("./fs-lite.ts")
      return factory(store)
    }
    case "redis": {
      const { default: factory } = await import("@vite-hub/kv/runtime/redis-driver")
      return factory(store)
    }
    case "upstash": {
      const { default: factory } = await import("@vite-hub/kv/runtime/upstash-driver")
      return factory(store)
    }
  }
}

export function createLazyKVRuntimeDriver(config: ResolvedKVModuleOptions, loadDatabases?: KVDatabasesLoader): KVRuntimeDriver {
  let driverPromise: Promise<Driver> | undefined
  let disposed = false

  function resolve(): Promise<Driver> {
    if (disposed) return Promise.reject(new Error("KV storage has been disposed."))
    if (driverPromise) return driverPromise
    const pending = (async () => {
      const runtime = resolveRuntimeKVOptions(config)
      if (!runtime) throw kvErrorDiagnostics.KV_DISABLED()
      return createRuntimeDriver(runtime.store, loadDatabases)
    })()
    driverPromise = pending
    void pending.catch(() => {
      if (driverPromise === pending) driverPromise = undefined
    })
    return pending
  }

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
          disposed = true
          if (!driverPromise) return
          // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- The promise resolves only from createRuntimeDriver.
          // SAFETY: createRuntimeDriver returns the callable driver record inspected here.
          const driver = await driverPromise as unknown as AnyRecord
          // SAFETY: dispose is optional and invoked only when callable.
          const fn = driver.dispose as ((this: unknown) => unknown) | undefined
          return fn?.call(driver)
        }
      }
      if (batchDriverMethods.has(prop)) {
        return async (...args: unknown[]) => {
          const driver = await resolve()
          const batch = prop === "getItems" ? driver.getItems ?? getItemsOneByOne(driver) : driver.setItems ?? setItemsOneByOne(driver)
          // SAFETY: The arguments come from unstorage's batch call, which matches the driver's batch method.
          return (batch as (this: unknown, ...args: unknown[]) => unknown).apply(driver, args)
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
