import { digitaloceanSpaces } from "files-sdk/digitalocean-spaces"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, DigitalOceanSpacesBlobStoreConfig } from "../types.ts"

export function createDriver(options: DigitalOceanSpacesBlobStoreConfig): BlobDriverAdapter<DigitalOceanSpacesBlobStoreConfig> {
  return createFilesSdkDriver(options, digitaloceanSpaces)
}
