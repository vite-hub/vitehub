import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, ResolvedMinioBlobStoreConfig } from "../types.ts"

const s3PeerInstall = "@aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner"

export function createDriver(options: ResolvedMinioBlobStoreConfig): BlobDriverAdapter<ResolvedMinioBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/minio"), "files-sdk/minio", options.driver, s3PeerInstall)).minio(options))
}
