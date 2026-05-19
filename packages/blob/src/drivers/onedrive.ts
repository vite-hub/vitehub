import { onedrive } from "files-sdk/onedrive"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, OneDriveBlobStoreConfig } from "../types.ts"

export function createDriver(options: OneDriveBlobStoreConfig): BlobDriverAdapter<OneDriveBlobStoreConfig> {
  return createFilesSdkDriver(options, onedrive)
}
