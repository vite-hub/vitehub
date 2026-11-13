import type { HostRequestEvent, ViteHubContext } from "@vite-hub/runtime/internal/h3"
import type { AccessAuthorize, AnonymousAccessAuthorize, Result } from "@vite-hub/runtime"

import type { BlobImagesOptions, BlobImageVariant, MediaCrop, MediaFocalPoint, MediaRecord, MediaUpdate, MediaVariantEntry } from "./media/types.ts"

export type BlobDriver =
  | "azure"
  | "cloudflare-r2"
  | "fs"
  | "gcs"
  | "minio"
  | "netlify-blobs"
  | "s3"
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

export type BlobOperation = "copy" | "delete" | "get" | "head" | "list" | "media" | "multipart" | "put" | "serve" | "sign" | "upload"
/**
 * `BLOB_CONFLICT` reports a copy or a media move onto an existing object, or the removal of a non-empty folder.
 * `BLOB_PATHNAME_TOO_LONG` reports a pathname above the host limit, such as 1024 bytes on Cloudflare R2.
 */
export type BlobErrorCode = "BLOB_CONFLICT" | "BLOB_NOT_FOUND" | "BLOB_OPERATION_FAILED" | "BLOB_PATHNAME_TOO_LONG"

export type BlobSignOptions =
  | { expiresIn: number, method: "GET" }
  | {
    contentType?: string
    createOnly?: boolean
    expiresIn: number
    /** The largest body that the upload accepts, such as `"8MB"`. Only the `fs` driver binds it. */
    maxSize?: BlobSize
    method: "PUT"
  }

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
  abort(): Promise<Result<void, BlobErrorCode>>
  complete(parts: BlobMultipartPart[]): Promise<Result<BlobObject, BlobErrorCode>>
  uploadPart(partNumber: number, body: BlobPutBody): Promise<Result<BlobMultipartPart, BlobErrorCode>>
}

/** Bytes of an object: `length` bytes from `offset` (to the end without `length`), or the last `suffix` bytes. */
export type BlobDriverByteRange = { offset: number, length?: number } | { suffix: number }

export interface BlobDriverStreamOptions {
  etag?: string
  range?: BlobDriverByteRange
}

/** An object and a stream of its bytes, or of the requested range of them, read in one storage call. */
export interface BlobDriverStream {
  object: BlobObject & { size: number }
  /** Empty when the range starts past the end of the object. */
  body: ReadableStream
}

export interface BlobDriverAdapter<TOptions> {
  /** Canonical identity for drivers that resolve pathname aliases. */
  canonicalPathname?(pathname: string): string
  name: string
  options: TOptions
  /**
   * Copy an object with its content type and custom metadata, in the provider when it can. Returns `null` when `from`
   * does not exist. Without it, `copy()` reads the object and writes it again.
   */
  copy?(from: string, to: string): Promise<BlobObject | null>
  createMultipartUpload?(pathname: string, options: BlobMultipartOptions): Promise<BlobDriverMultipartUpload>
  delete(pathnames: string | string[]): Promise<void>
  get(pathname: string): Promise<Blob | null>
  getArrayBuffer(pathname: string): Promise<ArrayBuffer | null>
  /**
   * Stream an object, or a range of it, with its metadata, without reading it into memory. `serve()` uses it when the
   * driver has it. With `etag` (an `httpEtag` the driver returned), returns `false` once the object has changed.
   */
  getStream?(pathname: string, options?: BlobDriverStreamOptions): Promise<BlobDriverStream | false | null>
  head(pathname: string): Promise<BlobObject | null>
  list(options?: BlobListOptions): Promise<BlobListResult>
  put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<BlobObject>
  resumeMultipartUpload?(pathname: string, uploadId: string): Promise<BlobDriverMultipartUpload>
  /** `store` names the Blob Store, for a driver that signs links to the app itself. */
  sign?(pathname: string, options: BlobSignOptions, context: { store: string }): Promise<BlobSignedRequest>
}

/**
 * What `handleUpload()` reads: a web Request, or a request event such as the event of a Nitro 3, H3, or `nuxt/server`
 * handler.
 */
export type BlobUploadEvent = Request | ViteHubContext | HostRequestEvent

/**
 * A request event that `handleMultipartUpload()` reads: its request, and the `action` and `pathname` route params in
 * `context.params`. The event of a Nitro 3, H3, or `nuxt/server` handler has both.
 */
export type BlobMultipartEvent = (ViteHubContext | HostRequestEvent) & { context: { params?: Record<string, string | undefined> } }

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

export interface BlobServeResponseOptions {
  /** Defaults to the `Cache-Control` of `headers`, or `private, no-cache`. */
  cacheControl?: string
  /**
   * Send `Content-Disposition: attachment`, so a browser saves the file and does not open it. `true` uses the last
   * segment of the pathname as the file name. A string sets the file name.
   */
  download?: boolean | string
  /**
   * On Cloudflare, keep the object in the cache of the location that runs the Worker for `maxAge` seconds, and answer
   * the next `GET` requests there from that cache, without reading storage. A later write to the pathname is not seen
   * until the entry expires, so give a long `maxAge` only to pathnames that are never written again. Call `serve()` after
   * your own authorization: a cached object is served to whoever reaches the call. Other hosts, `HEAD` requests,
   * `variant`, and `transform` read storage each time.
   */
  edgeCache?: { maxAge: number }
  /** More headers for a response that serves the object, including `206`, `304`, and `416`. Error responses do not get them. */
  headers?: Record<string, string>
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
  createFolder(path: string): Promise<Result<void, BlobErrorCode>>
  /** Read the record of an object. Builds and stores it when it is missing or the object changed. `null` when the object does not exist. */
  get(pathname: string | { pathname: string }): Promise<Result<MediaRecord | null, BlobErrorCode>>
  /** Store the files of a `multipart/form-data` request as media. */
  handleUpload(event: BlobUploadEvent, options?: BlobMediaUploadOptions): Promise<Result<MediaRecord[], BlobErrorCode>>
  /** List records and folders. */
  list(options?: BlobMediaListOptions): Promise<Result<BlobMediaListResult, BlobErrorCode>>
  /** Copy an object, its record, and its crop replacements to `to`, then delete the source and its variants. */
  move(from: string, to: string, options?: { overwrite?: boolean }): Promise<Result<MediaRecord, BlobErrorCode>>
  /** Move every object of a folder. Fails with `BLOB_CONFLICT` when the destination folder is not empty. */
  moveFolder(from: string, to: string): Promise<Result<{ moved: number }, BlobErrorCode>>
  /** Store an object, probe its dimensions, hash it, and write its record. */
  put(pathname: string, body: BlobPutBody, options?: BlobMediaPutOptions): Promise<Result<MediaRecord, BlobErrorCode>>
  /** Delete an object, its record, its crop replacements, and its variants. */
  remove(pathname: string): Promise<Result<void, BlobErrorCode>>
  /** Delete an empty folder. Fails with `BLOB_CONFLICT` when it holds objects, unless `force` is set. */
  removeFolder(path: string, options?: { force?: boolean }): Promise<Result<{ removed: number }, BlobErrorCode>>
  /**
   * Upload an image that replaces one crop, or pass `null` to go back to cropping the original. A new crop takes the
   * aspect of the replacement.
   */
  replaceCrop(pathname: string, crop: string, body: BlobPutBody | null): Promise<Result<MediaRecord, BlobErrorCode>>
  /** Change alt text, caption, focal point, or crops. Focal point and crop changes clear cached variants. */
  update(pathname: string, patch: MediaUpdate): Promise<Result<MediaRecord, BlobErrorCode>>
  /** List cached variants of an object and its crop replacements. */
  variants(pathname: string): Promise<Result<MediaVariantEntry[], BlobErrorCode>>
}

/** Options of `blob.copy()`. */
export interface BlobCopyOptions {
  /** Replace an object at `to`. Defaults to `false`: the copy fails with `BLOB_CONFLICT`, as `media.move()` does. */
  overwrite?: boolean
}

export interface BlobStorage {
  /** Media records, folders, and image variants. */
  readonly media: BlobMedia
  /**
   * Copy an object to `to` in the same store, with its content type and custom metadata. Returns the new object.
   * `from` must exist (`BLOB_NOT_FOUND`), and `to` must be empty unless `overwrite` is set (`BLOB_CONFLICT`).
   * `to` follows the rules of `put()`. The provider copies the bytes when it can: S3 and Vercel Blob copy on the server,
   * the `fs` driver copies the file. R2 streams the object from the binding. Netlify Blobs reads and writes it.
   */
  copy(from: string, to: string, options?: BlobCopyOptions): Promise<Result<BlobObject, BlobErrorCode>>
  /** Start a multipart upload. Supported by the `fs`, `cloudflare-r2` (binding), and `vercel-blob` drivers. */
  createMultipartUpload(pathname: string, options?: BlobMultipartOptions): Promise<Result<BlobMultipartUpload, BlobErrorCode>>
  delete(pathnames: string | string[]): Promise<Result<void, BlobErrorCode>>
  get(pathname: string): Promise<Result<Blob | null, BlobErrorCode>>
  /** Serve the `create`, `upload`, `complete`, and `abort` requests that the multipart client sends. */
  handleMultipartUpload(event: BlobMultipartEvent, options?: BlobMultipartHandlerOptions): Promise<Result<BlobMultipartHandlerResult, BlobErrorCode>>
  /** Store the files of a `multipart/form-data` request. */
  handleUpload(event: BlobUploadEvent, options?: BlobUploadOptions): Promise<Result<BlobObject[], BlobErrorCode>>
  head(pathname: string): Promise<Result<BlobObject | null, BlobErrorCode>>
  list(options?: BlobListOptions): Promise<Result<BlobListResult, BlobErrorCode>>
  put(pathname: string, body: BlobPutBody, options?: BlobPutOptions): Promise<Result<BlobObject, BlobErrorCode>>
  /** Continue a multipart upload in a later request. */
  resumeMultipartUpload(pathname: string, uploadId: string): Promise<Result<BlobMultipartUpload, BlobErrorCode>>
  sign(pathname: string, options: BlobSignOptions): Promise<Result<BlobSignedRequest, BlobErrorCode>>
  /**
   * Answer a `GET` or `HEAD` request for one object. The `Response` has the final status and headers: `200`, `206` or
   * `416` for a `Range`, `304` for `If-None-Match`, `400` for an unsafe pathname, and `404` for a missing object or a
   * reserved ViteHub path. A storage failure throws its `ViteHubError`. Return the `Response` from a route as it is. In
   * an H3 handler, pass `event.req`.
   */
  serve(request: Request, pathname: string, options?: BlobServeResponseOptions): Promise<Response>
  /** Selects a named Blob Store. `{ mode: "read" }` returns a handle without write methods. */
  store(name: BlobStoreName, options?: { mode?: "write" }): BlobStorage
  store(name: BlobStoreName, options: { mode: "read" }): ReadonlyBlobStorage
  store(name: BlobStoreName, options?: BlobStoreOptions): BlobStorage | ReadonlyBlobStorage
}

/** Options of `blob.store()`. */
export interface BlobStoreOptions {
  /** `"read"` returns a handle without write methods. Defaults to `"write"`. */
  mode?: "read" | "write"
}

/**
 * Blob handle from `blob.store(name, { mode: "read" })`. It has only read methods, and `sign()` signs `GET` requests only.
 * It limits this API, not the host: the R2 binding or provider token keeps full access, so it is not a security boundary
 * against code that reads the binding directly. `media.get()` and `serve()` with a transform or variant can still store
 * derived records and variants under the reserved `_vitehub/` prefix. They never change your objects.
 */
export interface ReadonlyBlobStorage {
  /** Media records and image variants, without write methods. */
  readonly media: Pick<BlobMedia, "get" | "list" | "variants">
  get: BlobStorage["get"]
  head: BlobStorage["head"]
  list: BlobStorage["list"]
  serve: BlobStorage["serve"]
  /** Signs a short-lived `GET` request. */
  sign(pathname: string, options: Extract<BlobSignOptions, { method: "GET" }>): Promise<Result<BlobSignedRequest, BlobErrorCode>>
}

/**
 * Cloudflare R2 jurisdiction that keeps bucket data in one region.
 * @see https://developers.cloudflare.com/r2/reference/data-location/#jurisdictional-restrictions
 */
export type CloudflareR2Jurisdiction = "eu" | "fedramp" | "us"

interface HostedBlobStoreConfig {
  /**
   * In `vite dev`, use this hosted store instead of the local `fs` store, so writes change real data. Without it,
   * `vite dev` never picks a hosted store from env or the host preset. An explicit `driver` is always used. Builds ignore it.
   */
  remote?: boolean
}

export interface CloudflareR2BlobStoreConfig extends HostedBlobStoreConfig {
  accountId?: string
  accessKeyId?: string
  binding?: string
  bucketName?: string
  defaultUrlExpiresIn?: number
  driver: "cloudflare-r2"
  /** Jurisdiction of the bucket. Sets the wrangler binding, the provisioning request, and the S3 API host. */
  jurisdiction?: CloudflareR2Jurisdiction
  publicBaseUrl?: string
  secretAccessKey?: string
}

export interface FsBlobStoreConfig {
  base?: string
  driver: "fs"
  /** A local store cannot be remote: `remote: true` fails with `BLOB_C0018`. */
  remote?: boolean
  /**
   * Origin of the links that `sign()` returns, such as `https://app.example`. Add the base URL of the app when it has
   * one, such as `https://app.example/app`. Without it, the links start with `/_vitehub/blob/signed/`.
   */
  urlBaseUrl?: string
}

export interface VercelBlobStoreConfig extends HostedBlobStoreConfig {
  access?: "private" | "public"
  allowOverwrite?: boolean
  downloadTimeoutMs?: number
  driver: "vercel-blob"
  token?: string
}

export interface S3BlobStoreConfig extends HostedBlobStoreConfig {
  bucket: string
  credentials?: { accessKeyId: string, secretAccessKey: string, sessionToken?: string }
  defaultUrlExpiresIn?: number
  driver: "s3"
  endpoint?: string
  forcePathStyle?: boolean
  publicBaseUrl?: string
  region?: string
}

export interface GcsBlobStoreConfig extends HostedBlobStoreConfig {
  bucket: string
  credentials?: { client_email: string, private_key: string }
  defaultUrlExpiresIn?: number
  driver: "gcs"
  keyFilename?: string
  projectId?: string
  publicBaseUrl?: string
}

export interface AzureBlobStoreConfig extends HostedBlobStoreConfig {
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

export interface NetlifyBlobsStoreConfig extends HostedBlobStoreConfig {
  consistency?: "eventual" | "strong"
  deployScoped?: boolean
  driver: "netlify-blobs"
  name: string
  siteID?: string
  token?: string
}

export type BlobStoreConfig =
  | AzureBlobStoreConfig
  | CloudflareR2BlobStoreConfig
  | FsBlobStoreConfig
  | GcsBlobStoreConfig
  | MinioBlobStoreConfig
  | NetlifyBlobsStoreConfig
  | S3BlobStoreConfig
  | VercelBlobStoreConfig

export interface MinioBlobStoreConfig extends HostedBlobStoreConfig {
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

export interface ResolvedCloudflareR2BlobStoreConfig extends CloudflareR2BlobStoreConfig, ResolvedBlobStoreSecrets {
  binding: string
  /** Set only in `vite dev` for a store that the Cloudflare preset picks: without the R2 binding, the store uses this local store. */
  localFallback?: ResolvedFsBlobStoreConfig
}

export interface ResolvedFsBlobStoreConfig extends FsBlobStoreConfig {
  base: string
}

export interface ResolvedVercelBlobStoreConfig extends VercelBlobStoreConfig {
  access: "private" | "public"
  /** Absent at runtime when the store uses Vercel OIDC with `BLOB_STORE_ID`. */
  token?: string
  /** Preserves explicit token precedence when build-time masking hides its value. */
  tokenFromConfig?: boolean
}

export interface ResolvedMinioBlobStoreConfig extends MinioBlobStoreConfig {
  bucket: string
  endpoint: string
  forcePathStyle: boolean
  region: string
}

export interface ResolvedBlobStoreSecrets {
  /** The env variable that holds each credential option, by option path. The resolved config has the mask in place of the value. */
  secretEnv?: Record<string, string>
}

export type ResolvedBlobStoreConfig = ResolvedBlobStoreSecrets & (
  | Exclude<BlobStoreConfig, CloudflareR2BlobStoreConfig | FsBlobStoreConfig | MinioBlobStoreConfig | VercelBlobStoreConfig>
  | ResolvedCloudflareR2BlobStoreConfig
  | ResolvedFsBlobStoreConfig
  | ResolvedMinioBlobStoreConfig
  | ResolvedVercelBlobStoreConfig
)

/**
 * The configured Blob stores, by name. ViteHub writes it to `.vitehub/types/blob.d.ts` from `blob.stores`, so
 * `blob.store()` rejects an unknown name before the app runs.
 */
export interface BlobStoreRegistry {}

/** A key of `blob.stores`. Before ViteHub writes the generated types, any name type checks. */
export type BlobStoreName = [keyof BlobStoreRegistry] extends [never] ? "default" | (string & {}) : Extract<keyof BlobStoreRegistry, string>

export type BlobServeOptions = boolean | {
  /** Requires a signed-in Auth session. Export `authorize` from `server/blob.ts` to also decide each request. */
  authorize?: boolean
  /**
   * Also runs the `authorize` export for signed-out callers, with `session` and `user` set to `null`.
   * Requires `authorize: true` and an `authorize` export (type `BlobServeAnonymousAuthorize`).
   */
  anonymous?: boolean
  headers?: Record<string, string>
  publicBaseUrl?: string
  route?: string
  /** A key of `blob.stores`. Defaults to `"default"`. */
  store?: string
}

/** Decides whether a signed-in user can read one object from the Blob serve route. */
export type BlobServeAuthorize = AccessAuthorize

/** Decides whether a signed-in or signed-out caller can read one object. Used with `blob.serve.anonymous: true`. */
export type BlobServeAnonymousAuthorize = AnonymousAccessAuthorize

export interface BlobServeConfig {
  anonymous?: true
  authorize?: true
  headers?: Record<string, string>
  publicBaseUrl?: string
  route: string
  store: string
}

interface BlobModuleBaseOptions {
  /** Image variants of served objects. Set `false` to always serve originals. */
  images?: false | BlobImagesOptions
  serve?: BlobServeOptions
}

export interface BlobStoresConfig extends BlobModuleBaseOptions {
  stores: Record<string, BlobStoreConfig>
}

export type BlobOptions =
  | false
  | BlobStoresConfig
  | (BlobModuleBaseOptions & HostedBlobStoreConfig & { driver?: undefined } & Partial<Pick<ResolvedCloudflareR2BlobStoreConfig, "binding" | "bucketName" | "jurisdiction">>)
  | (BlobModuleBaseOptions & HostedBlobStoreConfig & { driver?: undefined } & Partial<Pick<NetlifyBlobsStoreConfig, "name">>)
  | (BlobModuleBaseOptions & BlobStoreConfig)

export interface ResolvedBlobModuleOptions {
  /** Present when `blob.images` is set. Without it, variants use the `auto` transformer. */
  images?: false | BlobImagesOptions
  serve?: BlobServeConfig
  store: ResolvedBlobStoreConfig
  stores?: Record<string, ResolvedBlobStoreConfig>
}
