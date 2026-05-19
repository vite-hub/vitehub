import { akamai } from "files-sdk/akamai"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, AkamaiBlobStoreConfig } from "../types.ts"

export function createDriver(options: AkamaiBlobStoreConfig): BlobDriverAdapter<AkamaiBlobStoreConfig> {
  return createFilesSdkDriver(options, akamai)
}
