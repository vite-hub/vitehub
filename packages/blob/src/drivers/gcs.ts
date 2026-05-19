import { gcs } from "files-sdk/gcs"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, GcsBlobStoreConfig } from "../types.ts"

export function createDriver(options: GcsBlobStoreConfig): BlobDriverAdapter<GcsBlobStoreConfig> {
  return createFilesSdkDriver(options, gcs)
}
