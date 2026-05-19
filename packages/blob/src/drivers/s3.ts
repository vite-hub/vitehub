import { s3 } from "files-sdk/s3"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, S3BlobStoreConfig } from "../types.ts"

export function createDriver(options: S3BlobStoreConfig): BlobDriverAdapter<S3BlobStoreConfig> {
  return createFilesSdkDriver(options, s3)
}
