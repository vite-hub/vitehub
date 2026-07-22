import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createDriver as createNativeDriver, getOptionalBucket } from "./cloudflare-native.ts"
import { runtimeValue } from "./cloudflare-runtime.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, BlobSignedRequest, BlobSignOptions, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"

const s3PeerInstall = "files-sdk @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner"

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
