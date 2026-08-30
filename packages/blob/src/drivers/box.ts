import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, BoxBlobStoreConfig } from "../types.ts"

export function createDriver(options: BoxBlobStoreConfig): BlobDriverAdapter<BoxBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/box"), "files-sdk/box", options.driver, getFilesSdkPeerInstall(options.driver))).box(options))
}
