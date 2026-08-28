import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, UploadThingBlobStoreConfig } from "../types.ts"

export function createDriver(options: UploadThingBlobStoreConfig): BlobDriverAdapter<UploadThingBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/uploadthing"), "files-sdk/uploadthing", options.driver, getFilesSdkPeerInstall(options.driver))).uploadthing(options))
}
