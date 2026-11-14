import type { Result } from "@vite-hub/runtime"
import type { GetItemType, GetItemTypeMap } from "unstorage"

export type KVDriver = "cloudflare-kv-binding" | "database" | "deno-kv" | "fs-lite" | "redis" | "upstash"

/**
 * The atomic operations of each driver. A store returns `KV_UNSUPPORTED_OPERATION` for an atomic operation that its
 * driver does not list. `get`, `set`, `del`, `has`, `keys`, `list`, and `clear` work on every driver.
 */
export interface KVDriverAtomicOperations {
  "cloudflare-kv-binding": never
  "database": "deleteIfEquals" | "getAndDelete" | "increment" | "setIfAbsent"
  "deno-kv": "setIfAbsent"
  "fs-lite": "setIfAbsent"
  "redis": "deleteIfEquals" | "getAndDelete" | "increment" | "setIfAbsent"
  "upstash": "deleteIfEquals" | "getAndDelete" | "increment" | "setIfAbsent"
}

/** The drivers that run `operation` atomically, for example `KVDriversWith<"deleteIfEquals">`. */
export type KVDriversWith<TOperation extends KVAtomicOperation> = {
  [Driver in KVDriver]: TOperation extends KVDriverAtomicOperations[Driver] ? Driver : never
}[KVDriver]

/** The KV operations that need an atomic provider operation. */
export type KVAtomicOperation = "deleteIfEquals" | "getAndDelete" | "increment" | "setIfAbsent"

export interface CloudflareKVStoreConfig {
  driver: "cloudflare-kv-binding"
  binding?: string
  /**
   * In `vite dev`, use the real namespace: ViteHub writes `remote: true` on the Wrangler binding and does not fall back
   * to the local `fs-lite` store. Writes change real data. Builds ignore it.
   */
  remote?: boolean
  /** Cloudflare KV namespace id. When omitted, the build reads the id recorded by `vitehub provision run`. */
  namespaceId?: string
  /** Cloudflare KV namespace title that `vitehub provision run` finds or creates when `namespaceId` is not set. */
  namespaceName?: string
}

export interface UpstashKVStoreConfig {
  driver: "upstash"
  /** An Upstash store is always remote, in `vite dev` too. */
  remote?: true
  token?: string
  url?: string
  /**
   * Prefix of every key in Upstash. Default `vitehub:kv:<store>`, as for a Redis store, so `kv.clear()` and `kv.keys()`
   * stay inside the store. An empty value uses the default.
   */
  base?: string
}

export interface RedisKVStoreConfig {
  driver: "redis"
  /**
   * The Redis URL, such as `redis://user:password@host:6379`. Default `env:REDIS_URL`: the server reads `REDIS_URL`
   * when the store starts, not at build time. `env:<NAME>` reads another variable. A literal URL goes into the build
   * output, so keep passwords in a variable.
   */
  url?: string
  /**
   * Prefix of every key in Redis. Default `vitehub:kv:<store>`, which keeps keys that are not ViteHub's apart.
   * The generated store segment escapes `%`, `:`, `/`, `\`, and `?`; an empty store name uses `%`.
   * Two ViteHub apps on one Redis database share this default, so give each app its own database or `base`.
   * An empty value uses the default.
   */
  base?: string
  /** A Redis store uses the server that `url` points to, in `vite dev` too. */
  remote?: never
}

export interface DatabaseKVStoreConfig {
  driver: "database"
  /**
   * The Database that keeps the keys, in the table `vitehub_kv`. Default `"default"`. The store creates the table when
   * it is missing. Postgres and libSQL work. D1 does not.
   */
  database?: string
  /** A Database store uses the Database of the app, in `vite dev` too. */
  remote?: never
}

export interface DenoKVStoreConfig {
  driver: "deno-kv"
  path?: string
  /** A Deno KV store is local. */
  remote?: false
}

export interface FsLiteKVStoreConfig {
  driver: "fs-lite"
  base?: string
  /** An `fs-lite` store is local. */
  remote?: false
}

/** A store without `driver`. ViteHub infers the driver from the host and the env. */
export interface InferredKVStoreConfig {
  driver?: undefined
  /**
   * In `vite dev`, the inferred store is local unless this is `true`: Upstash env and the Vercel host do not select
   * Upstash, and the Cloudflare host uses the local `fs-lite` store when the dev runtime has no KV binding. With
   * `true`, `vite dev` uses the real store, so writes change real data. Builds ignore it.
   */
  remote?: boolean
}

export type KVStoreConfig =
  | CloudflareKVStoreConfig
  | DatabaseKVStoreConfig
  | DenoKVStoreConfig
  | FsLiteKVStoreConfig
  | RedisKVStoreConfig
  | UpstashKVStoreConfig

export interface ResolvedCloudflareKVStoreConfig extends CloudflareKVStoreConfig {
  binding: string
  /** Only in `vite dev`: the `fs-lite` directory that the store uses when the runtime has no binding. */
  localBase?: string
  /** Only in `vite dev`. */
  remote?: true
}

export interface ResolvedUpstashKVStoreConfig extends UpstashKVStoreConfig {
  base: string
  token: string
  url: string
}

export interface ResolvedDenoKVStoreConfig extends DenoKVStoreConfig {
  path?: string
}

export interface ResolvedFsLiteKVStoreConfig extends FsLiteKVStoreConfig {
  base: string
  /** {@link ResolvedDatabaseKVStoreConfig.inferred} */
  inferred?: true
}

export interface ResolvedRedisKVStoreConfig extends RedisKVStoreConfig {
  base: string
  url: string
}

export interface ResolvedDatabaseKVStoreConfig extends DatabaseKVStoreConfig {
  database: string
  /** The value of the `namespace` column for the keys of this store: the store name. */
  namespace: string
  /**
   * The build inferred this store on Node. The server keeps this driver regardless of `REDIS_URL`.
   */
  inferred?: true
}

export type ResolvedKVStoreConfig =
  | ResolvedCloudflareKVStoreConfig
  | ResolvedDatabaseKVStoreConfig
  | ResolvedDenoKVStoreConfig
  | ResolvedFsLiteKVStoreConfig
  | ResolvedRedisKVStoreConfig
  | ResolvedUpstashKVStoreConfig

export type KVStoreName = "default" | (string & {})

export interface KVStoresConfig {
  stores: Record<string, KVStoreConfig>
}

export type KVOptions = KVStoreConfig | InferredKVStoreConfig | KVStoresConfig | false

export interface ResolvedKVModuleOptions {
  store: ResolvedKVStoreConfig
  stores?: Record<string, ResolvedKVStoreConfig>
}

export type KVOperation = "clear" | "delete" | "deleteIfEquals" | "get" | "getAndDelete" | "getMany" | "has" | "increment" | "keys" | "list" | "set" | "setIfAbsent" | "setMany"

/** Codes that KV operations return in the `[error, data]` tuple. Config errors throw instead. */
export type KVErrorCode =
  | "KV_INVALID_CURSOR"
  | "KV_INVALID_LIMIT"
  | "KV_INVALID_TTL"
  | "KV_KEY_TOO_LONG"
  | "KV_METADATA_TOO_LARGE"
  | "KV_OPERATION_FAILED"
  | "KV_TTL_TOO_SHORT"
  | "KV_UNSUPPORTED_OPERATION"
  | "KV_VALUE_TOO_LARGE"

export interface KVListOptions {
  /** Opaque continuation cursor returned by a previous page. */
  cursor?: string
  /** Maximum number of keys to read. Must be a positive integer. */
  limit: number
  prefix?: string
}

/** What `kv.get()` converts the stored value to: `text`, `json`, `bytes`, `stream`, or `blob`. */
export type KVGetType = GetItemType

/** The value type `kv.get()` returns for each {@link KVGetType}. */
export type KVGetTypeMap = GetItemTypeMap

/** Options of `kv.get()`. Other fields go to the driver. */
export type KVGetOptions<K extends KVGetType | undefined = KVGetType | undefined> = Record<string, unknown> & { type?: K }

/** A read value: the caller's `T` without a `type`, the converted type with one. */
type KVValue<T, K> = K extends KVGetType ? KVGetTypeMap[K] : T

export interface KVSetIfAbsentOptions {
  /** Seconds until the key expires. Without it, the key stays until you delete it. */
  ttl?: number
}

/** One entry of `kv.setMany()`. */
export interface KVEntry<T = unknown> {
  key: string
  value: T
}

export interface KVListPage {
  /** Provider-ordered keys. */
  keys: string[]
  /** Omitted when enumeration is complete. */
  cursor?: string
}

/**
 * Each method returns `[error, data]`. `error.code` is one of the codes in the method type.
 * Config errors, for example an unknown store name, throw.
 */
export interface KVStorage {
  clear(base?: string, options?: unknown): Promise<Result<void, "KV_OPERATION_FAILED">>
  delete(key: string, options?: unknown): Promise<Result<void, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>
  /**
   * Deletes the key only when its value equals `expected`, in one atomic step. Returns `true` when this call deleted it.
   * KV compares the stored text with `expected` serialized as `set()` stores it, so `{ a: 1, b: 2 }` and
   * `{ b: 2, a: 1 }` are different values. Use it to free a token that only its owner may free.
   * The drivers in {@link KVDriversWith}`<"deleteIfEquals">` support it. The others return `KV_UNSUPPORTED_OPERATION`.
   */
  deleteIfEquals<T = unknown>(key: string, expected: T): Promise<Result<boolean, "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>
  /**
   * Reads a value or returns `null`. Without `options.type`, a string value is parsed as JSON, so `"123"` reads back as `123`.
   * `{ type: "text" }` returns the stored text, and `json`, `bytes`, `stream`, and `blob` convert it to that type.
   */
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- KV values are intentionally caller-typed until schema-aware reads are added.
  get<T = unknown, K extends KVGetType | undefined = undefined>(key: string, options?: KVGetOptions<K>): Promise<Result<KVValue<T, K> | null, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>
  /**
   * Reads many keys in one call. Returns one value per key, in the order of `keys`, with `null` for a missing key.
   * `options` works as in `get()` and applies to every key. Stores with a batch read use it: Cloudflare KV reads 100
   * keys per call, Redis and Upstash use `MGET`, and the `database` driver runs one query. Other stores read the keys
   * one by one, 16 at a time.
   */
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- KV values are intentionally caller-typed until schema-aware reads are added.
  getMany<T = unknown, K extends KVGetType | undefined = undefined>(keys: readonly string[], options?: KVGetOptions<K>): Promise<Result<Array<KVValue<T, K> | null>, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>
  /**
   * Atomically returns and deletes a value. `{ type: "text" }` returns the stored text.
   * The drivers in {@link KVDriversWith}`<"getAndDelete">` support it. The others return `KV_UNSUPPORTED_OPERATION`.
   */
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- KV values are intentionally caller-typed until schema-aware reads are added.
  getAndDelete<T = unknown, K extends "text" | undefined = undefined>(key: string, options?: { type?: K }): Promise<Result<KVValue<T, K> | null, "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>
  has(key: string, options?: unknown): Promise<Result<boolean, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>
  /**
   * Atomically increments a counter. The TTL is applied only when the counter is created.
   * The drivers in {@link KVDriversWith}`<"increment">` support it. The others return `KV_UNSUPPORTED_OPERATION`.
   */
  increment(key: string, ttl: number): Promise<Result<number, "KV_INVALID_TTL" | "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>
  keys(base?: string, options?: unknown): Promise<Result<string[], "KV_OPERATION_FAILED">>
  list(options: KVListOptions): Promise<Result<KVListPage, "KV_INVALID_CURSOR" | "KV_INVALID_LIMIT" | "KV_OPERATION_FAILED">>
  /** Cloudflare KV stores return `KV_KEY_TOO_LONG`, `KV_VALUE_TOO_LARGE`, `KV_METADATA_TOO_LARGE`, and `KV_TTL_TOO_SHORT` before a write that Cloudflare rejects. */
  set<T = unknown>(key: string, value: T, options?: unknown): Promise<Result<void, "KV_KEY_TOO_LONG" | "KV_METADATA_TOO_LARGE" | "KV_OPERATION_FAILED" | "KV_TTL_TOO_SHORT" | "KV_VALUE_TOO_LARGE">>
  /**
   * Writes many keys in one call. `options` works as in `set()` and applies to every entry. When a key is in `entries`
   * more than once, the last entry wins. A `value` of `undefined` deletes the key, as `set()` does. The writes are not
   * atomic: when the call fails, some entries can be written. Redis sends one pipeline and the `database` driver runs one
   * statement. Other stores write the entries one by one, 16 at a time. A Cloudflare KV store checks every entry against
   * the Workers KV limits before it writes any.
   */
  setMany<T = unknown>(entries: readonly KVEntry<T>[], options?: unknown): Promise<Result<void, "KV_KEY_TOO_LONG" | "KV_METADATA_TOO_LARGE" | "KV_OPERATION_FAILED" | "KV_TTL_TOO_SHORT" | "KV_VALUE_TOO_LARGE">>
  /**
   * Writes the value only when the key has no value, in one atomic step.
   * Returns `true` when this call wrote the value and `false` when the key already had one.
   * The drivers in {@link KVDriversWith}`<"setIfAbsent">` support it. Cloudflare KV is eventually consistent and returns
   * `KV_UNSUPPORTED_OPERATION`.
   */
  setIfAbsent<T = unknown>(key: string, value: T, options?: KVSetIfAbsentOptions): Promise<Result<boolean, "KV_INVALID_TTL" | "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>
  /** Selects a named KV store. `{ mode: "read" }` returns a handle without write methods. */
  store(name: KVStoreName, options?: { mode?: "write" }): KVStorage
  store(name: KVStoreName, options: { mode: "read" }): ReadonlyKVStorage
  store(name: KVStoreName, options?: KVStoreOptions): KVStorage | ReadonlyKVStorage
}

/** Options of `kv.store()`. */
export interface KVStoreOptions {
  /** `"read"` returns a handle without write methods. Defaults to `"write"`. */
  mode?: "read" | "write"
}

/**
 * KV handle from `kv.store(name, { mode: "read" })`, with only `get()`, `getMany()`, `has()`, `keys()`, and `list()`.
 * It limits this API, not the host: the KV binding or provider token keeps full access, so it is not a security
 * boundary against code that reads the binding directly.
 */
export interface ReadonlyKVStorage {
  get: KVStorage["get"]
  getMany: KVStorage["getMany"]
  has: KVStorage["has"]
  keys: KVStorage["keys"]
  list: KVStorage["list"]
}
