import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, MinioBlobStoreConfig } from "../types.ts"

export function createDriver(options: MinioBlobStoreConfig): BlobDriverAdapter<MinioBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer<typeof import("files-sdk/minio")>("files-sdk/minio", options.driver, "files-sdk")).minio(options))
}
