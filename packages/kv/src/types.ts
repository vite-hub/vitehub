import type { ViteHubError, ViteHubErrorDetails } from "@vite-hub/runtime"

export type KVDriver = "cloudflare-kv-binding" | "deno-kv" | "upstash" | "fs-lite"

export interface CloudflareKVStoreConfig {
  driver: "cloudflare-kv-binding"
  binding?: string
  namespaceId?: string
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

export type KVOperation = "clear" | "del" | "get" | "has" | "keys" | "set"
export type KVErrorDetails = ViteHubErrorDetails & {
  operation: KVOperation
  store: string
}
export type KVResult<TResult> =
  | [error: null, value: TResult]
  | [error: ViteHubError<"KV_OPERATION_FAILED", KVErrorDetails>, value: undefined]

export interface KVStorage {
  clear(base?: string, options?: unknown): Promise<KVResult<void>>
  del(key: string, options?: unknown): Promise<KVResult<void>>
  get<T = unknown>(key: string, options?: unknown): Promise<KVResult<T | null>>
  has(key: string, options?: unknown): Promise<KVResult<boolean>>
  keys(base?: string, options?: unknown): Promise<KVResult<string[]>>
  set<T = unknown>(key: string, value: T, options?: unknown): Promise<KVResult<void>>
  store(name: KVStoreName): KVStorage
}
