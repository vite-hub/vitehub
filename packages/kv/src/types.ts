export type KVDriver = "cloudflare-kv-binding" | "upstash" | "fs-lite"

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

export interface FsLiteKVStoreConfig {
  driver: "fs-lite"
  base?: string
}

export type KVStoreConfig =
  | CloudflareKVStoreConfig
  | UpstashKVStoreConfig
  | FsLiteKVStoreConfig

export interface ResolvedCloudflareKVStoreConfig extends CloudflareKVStoreConfig {
  binding: string
}

export type ResolvedUpstashKVStoreConfig = Required<UpstashKVStoreConfig>

export interface ResolvedFsLiteKVStoreConfig extends FsLiteKVStoreConfig {
  base: string
}

export type ResolvedKVStoreConfig =
  | ResolvedCloudflareKVStoreConfig
  | ResolvedUpstashKVStoreConfig
  | ResolvedFsLiteKVStoreConfig

export type KVModuleOptions = KVStoreConfig | false

export interface ResolvedKVModuleOptions {
  store: ResolvedKVStoreConfig
}

export interface KVStorage {
  clear(base?: string, options?: unknown): Promise<void>
  del(key: string, options?: unknown): Promise<void>
  get<T = unknown>(key: string, options?: unknown): Promise<T | null>
  has(key: string, options?: unknown): Promise<boolean>
  keys(base?: string, options?: unknown): Promise<string[]>
  set<T = unknown>(key: string, value: T, options?: unknown): Promise<void>
}
