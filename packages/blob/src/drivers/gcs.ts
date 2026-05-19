import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, GcsBlobStoreConfig } from "../types.ts"

export function createDriver(options: GcsBlobStoreConfig): BlobDriverAdapter<GcsBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer<typeof import("files-sdk/gcs")>("files-sdk/gcs", options.driver, "files-sdk")).gcs(options))
}
