import { readEnv, trimmed } from "@vite-hub/internal/env"

import { isMaskedBlobRuntimeValue } from "../config.ts"
import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getActiveCloudflareBinding, getActiveCloudflareEnv } from "../runtime/state.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, BlobSignedRequest, BlobSignOptions, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"

const s3PeerInstall = "files-sdk @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner"

interface R2ObjectLike {
  arrayBuffer?: () => Promise<ArrayBuffer>
  body?: ReadableStream
  customMetadata?: Record<string, string>
  httpEtag?: string
  httpMetadata?: { contentType?: string }
  key: string
  size?: number
  uploaded?: Date
}

interface R2BucketLike {
  delete(key: string): Promise<void>
  get(key: string): Promise<R2ObjectLike | null>
  head(key: string): Promise<R2ObjectLike | null>
  list(options?: { cursor?: string, delimiter?: string, include?: string[], limit?: number, prefix?: string }): Promise<{ cursor?: string, delimitedPrefixes?: string[], objects: R2ObjectLike[], truncated?: boolean }>
  put(key: string, value: BlobPutBody, options?: { customMetadata?: Record<string, string>, httpMetadata?: { contentType?: string } }): Promise<R2ObjectLike>
}

function getOptionalBucket(options: ResolvedCloudflareR2BlobStoreConfig): R2BucketLike | undefined {
  return getActiveCloudflareBinding<R2BucketLike>(options.binding)
    || (globalThis as any).__env__?.[options.binding]
    || (globalThis as any)[options.binding]
}

function getBucket(options: ResolvedCloudflareR2BlobStoreConfig): R2BucketLike {
  const binding = getOptionalBucket(options)
  if (!binding) {
    throw new Error(`R2 binding "${options.binding}" not found`)
  }

  return binding
}

function runtimeValue(value: string | undefined, ...envNames: string[]): string | undefined {
  const current = trimmed(value)
  const env = getActiveCloudflareEnv() as Record<string, string | undefined> | undefined
    || (typeof process === "undefined" ? {} : process.env)
  return isMaskedBlobRuntimeValue(current) ? readEnv(env, ...envNames) : current
}

function createHttpDriver(options: ResolvedCloudflareR2BlobStoreConfig): BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig> {
  const bucketName = runtimeValue(options.bucketName, "BLOB_BUCKET_NAME", "CLOUDFLARE_R2_BUCKET_NAME", "R2_BUCKET_NAME")
  if (!bucketName) {
    throw new Error("Missing runtime environment variable `BLOB_BUCKET_NAME`, `CLOUDFLARE_R2_BUCKET_NAME`, or `R2_BUCKET_NAME` for Cloudflare R2 Blob.")
  }
  return createFilesSdkDriver({
    ...options,
    accountId: runtimeValue(options.accountId, "R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID"),
    accessKeyId: runtimeValue(options.accessKeyId, "R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID"),
    bucketName,
    secretAccessKey: runtimeValue(options.secretAccessKey, "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
  }, async resolved => (await importOptionalPeer<typeof import("files-sdk/r2")>("files-sdk/r2", resolved.driver, s3PeerInstall)).r2({
    ...resolved,
    bucket: resolved.bucketName,
  }))
}

async function signRequest(options: ResolvedCloudflareR2BlobStoreConfig, pathname: string, signOptions: BlobSignOptions): Promise<BlobSignedRequest> {
  const accountId = runtimeValue(options.accountId, "R2_ACCOUNT_ID", "CLOUDFLARE_R2_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID")
  const accessKeyId = runtimeValue(options.accessKeyId, "R2_ACCESS_KEY_ID", "CLOUDFLARE_R2_ACCESS_KEY_ID")
  const secretAccessKey = runtimeValue(options.secretAccessKey, "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_R2_SECRET_ACCESS_KEY")
  const bucket = runtimeValue(options.bucketName, "BLOB_BUCKET_NAME", "CLOUDFLARE_R2_BUCKET_NAME", "R2_BUCKET_NAME")
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("Cloudflare R2 signed requests require `accountId`, `accessKeyId`, `secretAccessKey`, and `bucketName` HTTP credentials.")
  }

  const [{ GetObjectCommand, PutObjectCommand, S3Client }, { getSignedUrl }] = await Promise.all([
    importOptionalPeer<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3", options.driver, s3PeerInstall),
    importOptionalPeer<typeof import("@aws-sdk/s3-request-presigner")>("@aws-sdk/s3-request-presigner", options.driver, s3PeerInstall),
  ])
  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
    requestChecksumCalculation: "WHEN_REQUIRED",
  })
  const headers: Record<string, string> = {}
  const command = signOptions.method === "GET"
    ? new GetObjectCommand({ Bucket: bucket, Key: pathname })
    : new PutObjectCommand({
        Bucket: bucket,
        ContentType: signOptions.contentType,
        IfNoneMatch: signOptions.createOnly ? "*" : undefined,
        Key: pathname,
      })
  if (signOptions.method === "PUT") {
    if (signOptions.contentType) headers["Content-Type"] = signOptions.contentType
    if (signOptions.createOnly) headers["If-None-Match"] = "*"
  }
  return {
    headers,
    method: signOptions.method,
    url: await getSignedUrl(client, command, {
      expiresIn: signOptions.expiresIn,
      signableHeaders: signOptions.method === "PUT" && signOptions.contentType
        ? new Set(["content-type"])
        : undefined,
    }),
  }
}

function mapObject(object: R2ObjectLike): BlobObject {
  const contentType = object.httpMetadata?.contentType
  return {
    contentType,
    customMetadata: object.customMetadata || {},
    httpEtag: object.httpEtag,
    httpMetadata: contentType ? { contentType } : {},
    pathname: object.key,
    size: object.size,
    uploadedAt: object.uploaded || new Date(),
  }
}

async function readArrayBuffer(object: R2ObjectLike): Promise<ArrayBuffer> {
  if (typeof object.arrayBuffer === "function") {
    return await object.arrayBuffer()
  }
  if (object.body) {
    return await new Response(object.body).arrayBuffer()
  }
  return new ArrayBuffer(0)
}

function createNativeDriver(options: ResolvedCloudflareR2BlobStoreConfig): BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig> {
  return {
    name: "cloudflare-r2",
    options,
    async delete(pathnames) {
      await Promise.all((Array.isArray(pathnames) ? pathnames : [pathnames]).map(pathname => getBucket(options).delete(pathname)))
    },
    async get(pathname) {
      const object = await getBucket(options).get(pathname)
      if (!object) return null
      const bytes = await readArrayBuffer(object)
      return new Blob([bytes], { type: object.httpMetadata?.contentType || "" })
    },
    async getArrayBuffer(pathname) {
      const object = await getBucket(options).get(pathname)
      return object ? await readArrayBuffer(object) : null
    },
    async head(pathname) {
      const object = await getBucket(options).head(pathname)
      return object ? mapObject(object) : null
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const result = await getBucket(options).list({
        cursor: listOptions.cursor,
        delimiter: listOptions.folded ? "/" : undefined,
        include: ["customMetadata", "httpMetadata"],
        limit: listOptions.limit ?? 1000,
        prefix: listOptions.prefix,
      })
      return {
        blobs: result.objects.map(mapObject),
        cursor: result.truncated ? result.cursor : undefined,
        folders: listOptions.folded ? result.delimitedPrefixes?.sort((left, right) => left.localeCompare(right)) : undefined,
        hasMore: Boolean(result.truncated || result.cursor),
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const object = await getBucket(options).put(pathname, body, {
        customMetadata: putOptions.customMetadata,
        httpMetadata: {
          contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        },
      })
      return mapObject(object)
    },
  }
}

export function createDriver(options: ResolvedCloudflareR2BlobStoreConfig): BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig> {
  const nativeDriver = createNativeDriver(options)
  const activeDriver = () => getOptionalBucket(options) ? nativeDriver : createHttpDriver(options)

  return {
    name: "cloudflare-r2",
    options,
    delete: pathnames => activeDriver().delete(pathnames),
    get: pathname => activeDriver().get(pathname),
    getArrayBuffer: pathname => activeDriver().getArrayBuffer(pathname),
    head: pathname => activeDriver().head(pathname),
    list: options => activeDriver().list(options),
    put: (pathname, body, options) => activeDriver().put(pathname, body, options),
    sign: (pathname, signOptions) => signRequest(options, pathname, signOptions),
  }
}
