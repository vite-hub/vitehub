import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, BoxBlobStoreConfig } from "../types.ts"

export function createDriver(options: BoxBlobStoreConfig): BlobDriverAdapter<BoxBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/box"), "files-sdk/box", options.driver, "files-sdk")).box(options))
}
