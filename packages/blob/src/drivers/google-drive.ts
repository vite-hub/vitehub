import { googleDrive } from "files-sdk/google-drive"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, GoogleDriveBlobStoreConfig } from "../types.ts"

export function createDriver(options: GoogleDriveBlobStoreConfig): BlobDriverAdapter<GoogleDriveBlobStoreConfig> {
  return createFilesSdkDriver(options, googleDrive)
}
