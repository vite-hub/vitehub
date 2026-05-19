import { box } from "files-sdk/box"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, BoxBlobStoreConfig } from "../types.ts"

export function createDriver(options: BoxBlobStoreConfig): BlobDriverAdapter<BoxBlobStoreConfig> {
  return createFilesSdkDriver(options, box)
}
