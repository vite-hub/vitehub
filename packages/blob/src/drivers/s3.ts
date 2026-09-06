import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, S3BlobStoreConfig } from "../types.ts"

export function createDriver(options: S3BlobStoreConfig): BlobDriverAdapter<S3BlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/s3"), "files-sdk/s3", options.driver, getFilesSdkPeerInstall(options.driver))).s3(options))
}
