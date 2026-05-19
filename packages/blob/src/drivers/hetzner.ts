import { hetzner } from "files-sdk/hetzner"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, HetznerBlobStoreConfig } from "../types.ts"

export function createDriver(options: HetznerBlobStoreConfig): BlobDriverAdapter<HetznerBlobStoreConfig> {
  return createFilesSdkDriver(options, hetzner)
}
