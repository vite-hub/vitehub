import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, DropboxBlobStoreConfig } from "../types.ts"

export function createDriver(options: DropboxBlobStoreConfig): BlobDriverAdapter<DropboxBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/dropbox"), "files-sdk/dropbox", options.driver, "files-sdk")).dropbox(options))
}
