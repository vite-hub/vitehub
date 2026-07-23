import type { H3Event } from "h3"
import type { ViteHubError, ViteHubErrorDetails } from "@vite-hub/runtime"

export type BlobDriver =
  | "akamai"
  | "azure"
  | "box"
  | "cloudflare-r2"
  | "digitalocean-spaces"
  | "dropbox"
  | "fs"
  | "gcs"
  | "google-drive"
  | "hetzner"
  | "minio"
  | "netlify-blobs"
  | "onedrive"
  | "s3"
  | "storj"
  | "supabase"
  | "uploadthing"
  | "vercel-blob"
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

export type BlobPutBody = string | ReadableStream<unknown> | ArrayBuffer | ArrayBufferView | Blob

export type BlobOperation = "del" | "get" | "head" | "list" | "put" | "serve" | "sign"
export type BlobErrorCode = "BLOB_NOT_FOUND" | "BLOB_OPERATION_FAILED"
export type BlobErrorDetails = ViteHubErrorDetails & {
  operation: BlobOperation
  store: string
}
export type BlobResult<TResult> =
  | [error: null, value: TResult]
  | [error: ViteHubError<BlobErrorCode, BlobErrorDetails>, value: undefined]

export type BlobSignOptions =
  | { expiresIn: number, method: "GET" }
  | { contentType?: string, createOnly?: boolean, expiresIn: number, method: "PUT" }

export interface BlobSignedRequest {
  headers: Record<string, string>
  method: "GET" | "PUT"
  url: string
}

export interface BlobDriverAdapter<TOptions> {
  name: string
  options: TOptions
  delete(pathnames: string | string[]): Promise<void>
  get(pathname: string): Promise<Blob | null>
  getArrayBuffer(pathname: string): Promise<ArrayBuffer | null>
  head(pathname: string): Promise<BlobObject | null>
  list(options?: BlobListOptions): Promise<BlobListResult>
  put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<BlobObject>
  sign?(pathname: string, options: BlobSignOptions): Promise<BlobSignedRequest>
}

export interface BlobEnsureOptions {
  maxSize?: BlobSize
  types?: BlobType[]
}

export interface BlobStorage {
  del(pathnames: string | string[]): Promise<BlobResult<void>>
  get(pathname: string): Promise<BlobResult<Blob | null>>
  head(pathname: string): Promise<BlobResult<BlobObject>>
  list(options?: BlobListOptions): Promise<BlobResult<BlobListResult>>
  put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<BlobResult<BlobObject>>
  sign(pathname: string, options: BlobSignOptions): Promise<BlobResult<BlobSignedRequest>>
  serve(event: H3Event, pathname: string): Promise<BlobResult<ReadableStream>>
  store(name: BlobStoreName): BlobStorage
}

export interface CloudflareR2BlobStoreConfig {
  accountId?: string
  accessKeyId?: string
  binding?: string
  bucketName?: string
  defaultUrlExpiresIn?: number
  driver: "cloudflare-r2"
  publicBaseUrl?: string
  secretAccessKey?: string
}

export interface FsBlobStoreConfig {
  base?: string
  defaultUrlExpiresIn?: number
  driver: "fs"
  urlBaseUrl?: string
}

export interface VercelBlobStoreConfig {
  access?: "private" | "public"
  allowOverwrite?: boolean
  downloadTimeoutMs?: number
  driver: "vercel-blob"
  token?: string
}

export interface S3BlobStoreConfig {
  bucket: string
  credentials?: { accessKeyId: string, secretAccessKey: string, sessionToken?: string }
  defaultUrlExpiresIn?: number
  driver: "s3"
  endpoint?: string
  forcePathStyle?: boolean
  publicBaseUrl?: string
  region?: string
}

export interface GcsBlobStoreConfig {
  bucket: string
  credentials?: { client_email: string, private_key: string }
  defaultUrlExpiresIn?: number
  driver: "gcs"
  keyFilename?: string
  projectId?: string
  publicBaseUrl?: string
}

export interface AzureBlobStoreConfig {
  accountKey?: string
  accountName?: string
  connectionString?: string
  container: string
  defaultUrlExpiresIn?: number
  driver: "azure"
  endpoint?: string
  publicBaseUrl?: string
  sasToken?: string
}

export interface SupabaseBlobStoreConfig {
  bucket: string
  defaultUrlExpiresIn?: number
  driver: "supabase"
  key?: string
  public?: boolean
  publicBaseUrl?: string
  url?: string
}

export interface NetlifyBlobsStoreConfig {
  consistency?: "eventual" | "strong"
  deployScoped?: boolean
  driver: "netlify-blobs"
  name: string
  siteID?: string
  token?: string
}

interface S3CompatibleBlobStoreConfig {
  accessKeyId?: string
  bucket: string
  defaultUrlExpiresIn?: number
  driver: "akamai" | "digitalocean-spaces" | "hetzner" | "storj"
  endpoint?: string
  forcePathStyle?: boolean
  publicBaseUrl?: string
  region?: string
  secretAccessKey?: string
}

export interface UploadThingBlobStoreConfig {
  acl?: "private" | "public-read"
  defaultUrlExpiresIn?: number
  downloadTimeoutMs?: number
  driver: "uploadthing"
  region?: string
  slug?: string
  token?: string
}

export interface GoogleDriveBlobStoreConfig {
  credentials?: { client_email: string, private_key: string }
  driveId?: string
  driver: "google-drive"
  fileIdCacheSize?: number
  keyFilename?: string
  publicByDefault?: boolean
  rootFolderId?: string
  subject?: string
}

export interface OneDriveBlobStoreConfig {
  accessToken?: string | (() => string | Promise<string>)
  clientCredentials?: { tenantId: string, clientId: string, clientSecret: string }
  copyTimeoutMs?: number
  driveId?: string
  driver: "onedrive"
  oauth?: { clientId: string, clientSecret: string, refreshToken: string, tenantId?: string }
  publicByDefault?: boolean
  rootFolderPath?: string
  siteId?: string
  userId?: string
}

export interface DropboxBlobStoreConfig {
  accessToken?: string | (() => string | Promise<string>)
  appKey?: string
  appSecret?: string
  defaultUrlExpiresIn?: number
  driver: "dropbox"
  publicBaseUrl?: string
  publicByDefault?: boolean
  refreshToken?: string
  rootFolderPath?: string
}

export interface BoxBlobStoreConfig {
  ccg?: { clientId: string, clientSecret: string, enterpriseId?: string, userId?: string }
  defaultUrlExpiresIn?: number
  developerToken?: string
  driver: "box"
  jwt?: { configJsonString: string } | { configFilePath: string }
  oauth?: { clientId: string, clientSecret: string, refreshToken: string }
  publicBaseUrl?: string
  publicByDefault?: boolean
  rootFolderId?: string
}

export type BlobStoreConfig =
  | AkamaiBlobStoreConfig
  | AzureBlobStoreConfig
  | BoxBlobStoreConfig
  | CloudflareR2BlobStoreConfig
  | DigitalOceanSpacesBlobStoreConfig
  | DropboxBlobStoreConfig
  | FsBlobStoreConfig
  | GcsBlobStoreConfig
  | GoogleDriveBlobStoreConfig
  | HetznerBlobStoreConfig
  | MinioBlobStoreConfig
  | NetlifyBlobsStoreConfig
  | OneDriveBlobStoreConfig
  | S3BlobStoreConfig
  | StorjBlobStoreConfig
  | SupabaseBlobStoreConfig
  | UploadThingBlobStoreConfig
  | VercelBlobStoreConfig

export type AkamaiBlobStoreConfig = S3CompatibleBlobStoreConfig & { driver: "akamai", region: string }
export type DigitalOceanSpacesBlobStoreConfig = S3CompatibleBlobStoreConfig & { driver: "digitalocean-spaces", region: string }
export type HetznerBlobStoreConfig = S3CompatibleBlobStoreConfig & { driver: "hetzner", region: string }
export interface MinioBlobStoreConfig {
  accessKeyId?: string
  bucket?: string
  defaultUrlExpiresIn?: number
  driver: "minio"
  endpoint?: string
  forcePathStyle?: boolean
  publicBaseUrl?: string
  region?: string
  secretAccessKey?: string
}
export type StorjBlobStoreConfig = S3CompatibleBlobStoreConfig & { driver: "storj" }

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

export interface ResolvedMinioBlobStoreConfig extends MinioBlobStoreConfig {
  bucket: string
  endpoint: string
  forcePathStyle: boolean
  region: string
}

export type ResolvedBlobStoreConfig =
  | Exclude<BlobStoreConfig, CloudflareR2BlobStoreConfig | FsBlobStoreConfig | MinioBlobStoreConfig | VercelBlobStoreConfig>
  | ResolvedCloudflareR2BlobStoreConfig
  | ResolvedFsBlobStoreConfig
  | ResolvedMinioBlobStoreConfig
  | ResolvedVercelBlobStoreConfig

export type BlobStoreName = "default" | (string & {})

export type BlobServeOptions = boolean | {
  headers?: Record<string, string>
  publicBaseUrl?: string
  route?: string
  store?: BlobStoreName
}

export interface BlobServeConfig {
  headers?: Record<string, string>
  publicBaseUrl?: string
  route: string
  store: BlobStoreName
}

interface BlobModuleBaseOptions {
  serve?: BlobServeOptions
}

export interface BlobStoresConfig extends BlobModuleBaseOptions {
  stores: Record<string, BlobStoreConfig>
}

export type BlobModuleOptions =
  | false
  | BlobStoresConfig
  | (BlobModuleBaseOptions & { driver?: undefined } & Partial<Pick<ResolvedCloudflareR2BlobStoreConfig, "binding" | "bucketName">>)
  | (BlobModuleBaseOptions & { driver?: undefined } & Partial<Pick<NetlifyBlobsStoreConfig, "name">>)
  | (BlobModuleBaseOptions & BlobStoreConfig)

export interface ResolvedBlobModuleOptions {
  serve?: BlobServeConfig
  store: ResolvedBlobStoreConfig
  stores?: Record<string, ResolvedBlobStoreConfig>
}
