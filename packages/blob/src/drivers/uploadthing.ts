import { uploadthing } from "files-sdk/uploadthing"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, UploadThingBlobStoreConfig } from "../types.ts"

export function createDriver(options: UploadThingBlobStoreConfig): BlobDriverAdapter<UploadThingBlobStoreConfig> {
  return createFilesSdkDriver(options, uploadthing)
}
