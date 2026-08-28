import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, AzureBlobStoreConfig } from "../types.ts"

export function createDriver(options: AzureBlobStoreConfig): BlobDriverAdapter<AzureBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/azure"), "files-sdk/azure", options.driver, getFilesSdkPeerInstall(options.driver))).azure(options))
}
