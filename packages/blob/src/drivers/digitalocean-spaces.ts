import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, DigitalOceanSpacesBlobStoreConfig } from "../types.ts"

export function createDriver(options: DigitalOceanSpacesBlobStoreConfig): BlobDriverAdapter<DigitalOceanSpacesBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/digitalocean-spaces"), "files-sdk/digitalocean-spaces", options.driver, "files-sdk")).digitaloceanSpaces(options))
}
