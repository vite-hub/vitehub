import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, OneDriveBlobStoreConfig } from "../types.ts"

export function createDriver(options: OneDriveBlobStoreConfig): BlobDriverAdapter<OneDriveBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/onedrive"), "files-sdk/onedrive", options.driver, getFilesSdkPeerInstall(options.driver))).onedrive(options))
}
