import type { AccessAuthorize, ViteHubError, ViteHubErrorDetails } from "@vite-hub/runtime"

import type { BlobImagesOptions, BlobImageVariant, MediaCrop, MediaFocalPoint, MediaRecord, MediaUpdate, MediaVariantEntry } from "./media/types.ts"

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

export type BlobOperation = "del" | "get" | "head" | "list" | "media" | "multipart" | "put" | "serve" | "sign" | "upload"
/** `BLOB_CONFLICT` reports a media move onto an existing object or the removal of a non-empty folder. */
export type BlobErrorCode = "BLOB_CONFLICT" | "BLOB_NOT_FOUND" | "BLOB_OPERATION_FAILED"
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

/** One uploaded part. Pass every part to `complete()` in any order. */
export interface BlobMultipartPart {
  etag: string
  partNumber: number
}

/** Options for a new multipart upload. Size and type checks belong to the route that accepts the upload. */
export type BlobMultipartOptions = Omit<BlobPutOptions, "contentLength">

/** A multipart upload as a driver implements it. Methods throw on failure. */
export interface BlobDriverMultipartUpload {
  pathname: string
  uploadId: string
  abort(): Promise<void>
  complete(parts: BlobMultipartPart[]): Promise<BlobObject>
  uploadPart(partNumber: number, body: BlobPutBody): Promise<BlobMultipartPart>
}

/** A multipart upload. Each method returns `[error, value]`. */
export interface BlobMultipartUpload {
  /** Final object pathname, after `prefix` and `addRandomSuffix`. Use it to resume the upload. */
  pathname: string
  uploadId: string
  abort(): Promise<BlobResult<void>>
  complete(parts: BlobMultipartPart[]): Promise<BlobResult<BlobObject>>
  uploadPart(partNumber: number, body: BlobPutBody): Promise<BlobResult<BlobMultipartPart>>
}

export interface BlobDriverAdapter<TOptions> {
  /** Canonical identity for drivers that resolve pathname aliases. */
  canonicalPathname?(pathname: string): string
  name: string
  options: TOptions
  createMultipartUpload?(pathname: string, options: BlobMultipartOptions): Promise<BlobDriverMultipartUpload>
  delete(pathnames: string | string[]): Promise<void>
  get(pathname: string): Promise<Blob | null>
  getArrayBuffer(pathname: string): Promise<ArrayBuffer | null>
  head(pathname: string): Promise<BlobObject | null>
  list(options?: BlobListOptions): Promise<BlobListResult>
  put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<BlobObject>
  resumeMultipartUpload?(pathname: string, uploadId: string): Promise<BlobDriverMultipartUpload>
  sign?(pathname: string, options: BlobSignOptions): Promise<BlobSignedRequest>
}

/** The part of an H3 event that `handleUpload()` reads. */
export interface BlobUploadEvent {
  req: Request
}

/** The parts of an H3 event that `handleMultipartUpload()` reads: the request and the `action` and `pathname` route params. */
export interface BlobMultipartEvent extends BlobUploadEvent {
  context: { params?: Record<string, string | undefined> }
}

export interface BlobUploadOptions {
  /** Form field that holds the files. Defaults to `"files"`. */
  formKey?: string
  /** Accept more than one file. Defaults to `true`. */
  multiple?: boolean
  /** Validate each file with `ensureBlob()` before it is stored. */
  ensure?: BlobEnsureOptions
  /** Options for each `put()`. The file name is the pathname. */
  put?: BlobPutOptions
}

export interface BlobMultipartHandlerOptions {
  /** Options for `createMultipartUpload()`. The client sends only the content type. */
  create?: BlobMultipartOptions
}

/** What `handleMultipartUpload()` returns for each action. */
export type BlobMultipartHandlerResult =
  | { action: "abort" }
  | { action: "complete", object: BlobObject }
  | { action: "create", pathname: string, uploadId: string }
  | { action: "upload", part: BlobMultipartPart }

export interface BlobEnsureOptions {
  maxSize?: BlobSize
  types?: BlobType[]
}

export interface BlobServeEvent {
  req: Pick<Request, "headers" | "method">
  res: {
    headers: Headers
    status?: number
  }
}

export interface BlobServeResponseOptions {
  /** Defaults to the event's Cache-Control header, or private, no-cache. */
  cacheControl?: string
  /**
   * Serve a resized, cropped, or re-encoded image. The generated serve route reads it from `?w=&h=&fit=&fmt=&q=&crop=`.
   * Non-image objects, GIF, SVG, and stores without an image transformer serve the original.
   */
  variant?: BlobImageVariant
  /** Serve and cache a derived object without exposing the original. Takes precedence over `variant`. */
  transform?: {
    /** Change this key when the transformation or its parameters change. */
    key: string
    run: (original: Blob) => Blob | Promise<Blob>
  }
}

export interface BlobMediaPutOptions extends Omit<BlobPutOptions, "contentLength"> {
  alt?: string
  caption?: string
  crops?: Record<string, Pick<MediaCrop, "aspect" | "focal">>
  /** Return the existing record when the store already holds the same bytes, instead of writing a copy. Defaults to `false`. */
  dedupe?: boolean
  focal?: MediaFocalPoint
}

export interface BlobMediaUploadOptions {
  /** Return existing records for files whose bytes the store already holds. Defaults to `true`. */
  dedupe?: boolean
  /** Validate each file with `ensureBlob()` before it is stored. */
  ensure?: BlobEnsureOptions
  /** Folder for the uploaded files, such as `"posts/2026"`. */
  folder?: string
  /** Form field that holds the files. Defaults to `"files"`. */
  formKey?: string
  /** Accept more than one file. Defaults to `true`. */
  multiple?: boolean
  /** Options for each stored file. The file name is the pathname inside `folder`. */
  put?: Omit<BlobMediaPutOptions, "dedupe">
}

export interface BlobMediaListOptions {
  cursor?: string
  /** List one folder level. Defaults to `true`. */
  folded?: boolean
  /** From 1 to 1000. Defaults to 100. */
  limit?: number
  /** Folder or pathname prefix, such as `"posts/"`. */
  prefix?: string
}

export interface BlobMediaListResult {
  cursor?: string
  /** Child folders, each ending in `/`. ViteHub's reserved folders are hidden. */
  folders: string[]
  hasMore: boolean
  /**
   * Records of the listed objects. An object without a current record lists with its object fields and any stored
   * alt text, caption, focal point, and crops. `media.get()` reads it and stores a full record.
   */
  items: MediaRecord[]
}

/**
 * Media records, folders, and image variants of one Blob Store. Records are JSON objects in the same store, so
 * they work on every driver. Writes are last-writer-wins: a record, its object, and its crops change in separate
 * provider calls, so concurrent editors of one item can overwrite each other.
 */
export interface BlobMedia {
  /** Create an empty folder. It holds a `.keep` object, which `media.list()` hides. */
  createFolder(path: string): Promise<BlobResult<void>>
  /** Read the record of an object. Builds and stores it when it is missing or the object changed. `null` when the object does not exist. */
  get(pathname: string | { pathname: string }): Promise<BlobResult<MediaRecord | null>>
  /** Store the files of a `multipart/form-data` request as media. */
  handleUpload(event: BlobUploadEvent, options?: BlobMediaUploadOptions): Promise<BlobResult<MediaRecord[]>>
  /** List records and folders. */
  list(options?: BlobMediaListOptions): Promise<BlobResult<BlobMediaListResult>>
  /** Copy an object, its record, and its crop replacements to `to`, then delete the source and its variants. */
  move(from: string, to: string, options?: { overwrite?: boolean }): Promise<BlobResult<MediaRecord>>
  /** Move every object of a folder. Fails with `BLOB_CONFLICT` when the destination folder is not empty. */
  moveFolder(from: string, to: string): Promise<BlobResult<{ moved: number }>>
  /** Store an object, probe its dimensions, hash it, and write its record. */
  put(pathname: string, body: BlobPutBody, options?: BlobMediaPutOptions): Promise<BlobResult<MediaRecord>>
  /** Delete an object, its record, its crop replacements, and its variants. */
  remove(pathname: string): Promise<BlobResult<void>>
  /** Delete an empty folder. Fails with `BLOB_CONFLICT` when it holds objects, unless `force` is set. */
  removeFolder(path: string, options?: { force?: boolean }): Promise<BlobResult<{ removed: number }>>
  /**
   * Upload an image that replaces one crop, or pass `null` to go back to cropping the original. A new crop takes the
   * aspect of the replacement.
   */
  replaceCrop(pathname: string, crop: string, body: BlobPutBody | null): Promise<BlobResult<MediaRecord>>
  /** Change alt text, caption, focal point, or crops. Focal point and crop changes clear cached variants. */
  update(pathname: string, patch: MediaUpdate): Promise<BlobResult<MediaRecord>>
  /** List cached variants of an object and its crop replacements. */
  variants(pathname: string): Promise<BlobResult<MediaVariantEntry[]>>
}

export interface BlobStorage {
  /** Media records, folders, and image variants. */
  readonly media: BlobMedia
  /** Start a multipart upload. Supported by the `fs`, `cloudflare-r2` (binding), and `vercel-blob` drivers. */
  createMultipartUpload(pathname: string, options?: BlobMultipartOptions): Promise<BlobResult<BlobMultipartUpload>>
  del(pathnames: string | string[]): Promise<BlobResult<void>>
  get(pathname: string): Promise<BlobResult<Blob | null>>
  /** Serve the `create`, `upload`, `complete`, and `abort` requests that the multipart client sends. */
  handleMultipartUpload(event: BlobMultipartEvent, options?: BlobMultipartHandlerOptions): Promise<BlobResult<BlobMultipartHandlerResult>>
  /** Store the files of a `multipart/form-data` request. */
  handleUpload(event: BlobUploadEvent, options?: BlobUploadOptions): Promise<BlobResult<BlobObject[]>>
  head(pathname: string): Promise<BlobResult<BlobObject | null>>
  list(options?: BlobListOptions): Promise<BlobResult<BlobListResult>>
  put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<BlobResult<BlobObject>>
  /** Continue a multipart upload in a later request. */
  resumeMultipartUpload(pathname: string, uploadId: string): Promise<BlobResult<BlobMultipartUpload>>
  sign(pathname: string, options: BlobSignOptions): Promise<BlobResult<BlobSignedRequest>>
  /** Returns null for a conditional 304 response. */
  serve(event: BlobServeEvent, pathname: string, options?: BlobServeResponseOptions): Promise<BlobResult<ReadableStream | null>>
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
  /** Requires a signed-in Auth session. Export `authorize` from `server/blob.ts` to also decide each request. */
  authorize?: boolean
  headers?: Record<string, string>
  publicBaseUrl?: string
  route?: string
  store?: BlobStoreName
}

/** Decides whether a signed-in user can read one object from the Blob serve route. */
export type BlobServeAuthorize = AccessAuthorize

export interface BlobServeConfig {
  authorize?: true
  headers?: Record<string, string>
  publicBaseUrl?: string
  route: string
  store: BlobStoreName
}

interface BlobModuleBaseOptions {
  /** Image variants of served objects. Set `false` to always serve originals. */
  images?: false | BlobImagesOptions
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
  /** Present when `blob.images` is set. Without it, variants use the `auto` transformer. */
  images?: false | BlobImagesOptions
  serve?: BlobServeConfig
  store: ResolvedBlobStoreConfig
  stores?: Record<string, ResolvedBlobStoreConfig>
}
