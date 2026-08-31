import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, StorjBlobStoreConfig } from "../types.ts"

export function createDriver(options: StorjBlobStoreConfig): BlobDriverAdapter<StorjBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/storj"), "files-sdk/storj", options.driver, getFilesSdkPeerInstall(options.driver))).storj(options))
}
