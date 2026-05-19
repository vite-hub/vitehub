import { minio } from "files-sdk/minio"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, MinioBlobStoreConfig } from "../types.ts"

export function createDriver(options: MinioBlobStoreConfig): BlobDriverAdapter<MinioBlobStoreConfig> {
  return createFilesSdkDriver(options, minio)
}
