import { dropbox } from "files-sdk/dropbox"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, DropboxBlobStoreConfig } from "../types.ts"

export function createDriver(options: DropboxBlobStoreConfig): BlobDriverAdapter<DropboxBlobStoreConfig> {
  return createFilesSdkDriver(options, dropbox)
}
