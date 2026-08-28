import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, ResolvedMinioBlobStoreConfig } from "../types.ts"

export function createDriver(options: ResolvedMinioBlobStoreConfig): BlobDriverAdapter<ResolvedMinioBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/minio"), "files-sdk/minio", options.driver, getFilesSdkPeerInstall(options.driver))).minio(options))
}
