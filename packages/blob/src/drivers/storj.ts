import { storj } from "files-sdk/storj"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, StorjBlobStoreConfig } from "../types.ts"

export function createDriver(options: StorjBlobStoreConfig): BlobDriverAdapter<StorjBlobStoreConfig> {
  return createFilesSdkDriver(options, storj)
}
