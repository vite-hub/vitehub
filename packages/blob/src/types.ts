import type { H3Event } from "h3"

export type BlobDriver = "cloudflare-r2" | "fs" | "vercel-blob"
export type BlobType = "audio" | "blob" | "image" | "pdf" | "text" | "video" | `${string}/${string}`
export type SizeUnit = "B" | "GB" | "KB" | "MB"
type PowOf2 = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512 | 1024
export type BlobSize = `${PowOf2}${SizeUnit}`

export interface BlobObject {
  pathname: string
  contentType: string | undefined
  size?: number
  httpEtag: string | undefined
  uploadedAt: Date
  httpMetadata: Record<string, string>
  customMetadata: Record<string, string>
  url?: string
}

export interface BlobListOptions {
  cursor?: string
  folded?: boolean
  limit?: number
  prefix?: string
}

export interface BlobListResult {
  blobs: BlobObject[]
  cursor?: string
  folders?: string[]
  hasMore: boolean
}

export interface BlobPutOptions {
  access?: "private" | "public"
  addRandomSuffix?: boolean
  contentLength?: string
  contentType?: string
  customMetadata?: Record<string, string>
  prefix?: string
}

export interface BlobEnsureOptions {
  maxSize?: BlobSize
  types?: BlobType[]
}

export interface BlobStorage {
  delete(pathnames: string | string[]): Promise<void>
  del(pathnames: string | string[]): Promise<void>
  get(pathname: string): Promise<Blob | null>
  head(pathname: string): Promise<BlobObject>
  list(options?: BlobListOptions): Promise<BlobListResult>
  put(pathname: string, body: string | ReadableStream<unknown> | ArrayBuffer | ArrayBufferView | Blob, options?: BlobPutOptions): Promise<BlobObject>
  serve(event: H3Event, pathname: string): Promise<ReadableStream>
}

export interface CloudflareR2BlobStoreConfig {
  binding?: string
  bucketName?: string
  driver: "cloudflare-r2"
}

export interface FsBlobStoreConfig {
  base?: string
  driver: "fs"
}

export interface VercelBlobStoreConfig {
  access?: "private" | "public"
  driver: "vercel-blob"
  token?: string
}

export type BlobStoreConfig =
  | CloudflareR2BlobStoreConfig
  | FsBlobStoreConfig
  | VercelBlobStoreConfig

export interface ResolvedCloudflareR2BlobStoreConfig extends CloudflareR2BlobStoreConfig {
  binding: string
}

export interface ResolvedFsBlobStoreConfig extends FsBlobStoreConfig {
  base: string
}

export interface ResolvedVercelBlobStoreConfig extends VercelBlobStoreConfig {
  access: "private" | "public"
  token: string
}

export type ResolvedBlobStoreConfig =
  | ResolvedCloudflareR2BlobStoreConfig
  | ResolvedFsBlobStoreConfig
  | ResolvedVercelBlobStoreConfig

export type BlobModuleOptions =
  | false
  | ({ driver?: undefined } & Partial<Pick<ResolvedCloudflareR2BlobStoreConfig, "binding" | "bucketName">>)
  | BlobStoreConfig

export interface ResolvedBlobModuleOptions {
  store: ResolvedBlobStoreConfig
}
