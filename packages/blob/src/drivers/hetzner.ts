import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, HetznerBlobStoreConfig } from "../types.ts"

export function createDriver(options: HetznerBlobStoreConfig): BlobDriverAdapter<HetznerBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/hetzner"), "files-sdk/hetzner", options.driver, "files-sdk")).hetzner(options))
}
