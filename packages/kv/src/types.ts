import type { Result } from "@vite-hub/runtime"

export type KVDriver = "cloudflare-kv-binding" | "deno-kv" | "upstash" | "fs-lite"

export interface CloudflareKVStoreConfig {
  driver: "cloudflare-kv-binding"
  binding?: string
  /** Cloudflare KV namespace id. When omitted, the build reads the id recorded by `vitehub provision run`. */
  namespaceId?: string
  /** Cloudflare KV namespace title that `vitehub provision run` finds or creates when `namespaceId` is not set. */
  namespaceName?: string
}

export interface UpstashKVStoreConfig {
  driver: "upstash"
  token?: string
  url?: string
}

export interface DenoKVStoreConfig {
  driver: "deno-kv"
  path?: string
}

export interface FsLiteKVStoreConfig {
  driver: "fs-lite"
  base?: string
}

export type KVStoreConfig =
  | CloudflareKVStoreConfig
  | DenoKVStoreConfig
  | UpstashKVStoreConfig
  | FsLiteKVStoreConfig

export interface ResolvedCloudflareKVStoreConfig extends CloudflareKVStoreConfig {
  binding: string
}

export type ResolvedUpstashKVStoreConfig = Required<UpstashKVStoreConfig>

export interface ResolvedDenoKVStoreConfig extends DenoKVStoreConfig {
  path?: string
}

export interface ResolvedFsLiteKVStoreConfig extends FsLiteKVStoreConfig {
  base: string
}

export type ResolvedKVStoreConfig =
  | ResolvedCloudflareKVStoreConfig
  | ResolvedDenoKVStoreConfig
  | ResolvedUpstashKVStoreConfig
  | ResolvedFsLiteKVStoreConfig

export type KVStoreName = "default" | (string & {})

export interface KVStoresConfig {
  stores: Record<string, KVStoreConfig>
}

export type KVModuleOptions = KVStoreConfig | KVStoresConfig | false

export interface ResolvedKVModuleOptions {
  store: ResolvedKVStoreConfig
  stores?: Record<string, ResolvedKVStoreConfig>
}

export type KVOperation = "clear" | "del" | "get" | "getAndDelete" | "has" | "increment" | "keys" | "list" | "set"

/** Codes that KV operations return in the `[error, data]` tuple. Config errors throw instead. */
export type KVErrorCode =
  | "KV_INVALID_CURSOR"
  | "KV_INVALID_LIMIT"
  | "KV_INVALID_TTL"
  | "KV_OPERATION_FAILED"
  | "KV_UNSUPPORTED_OPERATION"

export interface KVListOptions {
  /** Opaque continuation cursor returned by a previous page. */
  cursor?: string
  /** Maximum number of keys to read. Must be a positive integer. */
  limit: number
  prefix?: string
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
  del(key: string, options?: unknown): Promise<Result<void, "KV_OPERATION_FAILED">>
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- KV values are intentionally caller-typed until schema-aware reads are added.
  get<T = unknown>(key: string, options?: unknown): Promise<Result<T | null, "KV_OPERATION_FAILED">>
  /** Atomically returns and deletes a value when the configured store supports it. */
  // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- KV values are intentionally caller-typed until schema-aware reads are added.
  getAndDelete<T = unknown>(key: string): Promise<Result<T | null, "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>
  has(key: string, options?: unknown): Promise<Result<boolean, "KV_OPERATION_FAILED">>
  /** Atomically increments a counter. The TTL is applied only when the counter is created. */
  increment(key: string, ttl: number): Promise<Result<number, "KV_INVALID_TTL" | "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>
  keys(base?: string, options?: unknown): Promise<Result<string[], "KV_OPERATION_FAILED">>
  list(options: KVListOptions): Promise<Result<KVListPage, "KV_INVALID_CURSOR" | "KV_INVALID_LIMIT" | "KV_OPERATION_FAILED">>
  set<T = unknown>(key: string, value: T, options?: unknown): Promise<Result<void, "KV_OPERATION_FAILED">>
  store(name: KVStoreName): KVStorage
}
