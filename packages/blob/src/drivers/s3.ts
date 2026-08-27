import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, S3BlobStoreConfig } from "../types.ts"

const s3PeerInstall = "@aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner"

export function createDriver(options: S3BlobStoreConfig): BlobDriverAdapter<S3BlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/s3"), "files-sdk/s3", options.driver, s3PeerInstall)).s3(options))
}
