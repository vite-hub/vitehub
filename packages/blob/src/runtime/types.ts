import type { H3Event } from "h3"
import type { BlobDriver } from "./drivers/types.ts"

export type PowOf2 = 1 | 2 | 4 | 8 | 16 | 32 | 64 | 128 | 256 | 512 | 1024
export type SizeUnit = "B" | "KB" | "MB" | "GB"
export type BlobSize = `${PowOf2}${SizeUnit}`
export type BlobType = "image" | "video" | "audio" | "pdf" | "text" | "blob" | `${string}/${string}`

export interface BlobObject {
  contentType: string | undefined
  customMetadata: Record<string, string>
  httpEtag: string | undefined
  httpMetadata: Record<string, string>
  pathname: string
  size?: number
  uploadedAt: Date
  url?: string
}

export type BlobReadableStream = ReadableStream<Uint8Array>
export type BlobBody = string | BlobReadableStream | ArrayBuffer | ArrayBufferView | Blob

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
  access?: "public" | "private"
  addRandomSuffix?: boolean
  contentLength?: string
  contentType?: string
  customMetadata?: Record<string, string>
  prefix?: string
  [key: string]: unknown
}

export interface BlobEnsureOptions {
  maxSize?: BlobSize
  types?: BlobType[]
}

export interface BlobUploadOptions {
  ensure?: BlobEnsureOptions
  formKey?: string
  multiple?: boolean
  put?: BlobPutOptions
}

export interface BlobStorage {
  del(pathnames: string | string[]): Promise<void>
  driver: BlobDriver<unknown>
  get(pathname: string): Promise<Blob | null>
  handleUpload(event: H3Event, options?: BlobUploadOptions): Promise<BlobObject[]>
  head(pathname: string): Promise<BlobObject>
  list(options?: BlobListOptions): Promise<BlobListResult>
  put(pathname: string, body: BlobBody, options?: BlobPutOptions): Promise<BlobObject>
  serve(event: H3Event, pathname: string): Promise<BlobReadableStream>
}
