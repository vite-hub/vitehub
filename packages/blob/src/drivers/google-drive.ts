import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, GoogleDriveBlobStoreConfig } from "../types.ts"

export function createDriver(options: GoogleDriveBlobStoreConfig): BlobDriverAdapter<GoogleDriveBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/google-drive"), "files-sdk/google-drive", options.driver, "files-sdk")).googleDrive(options))
}
