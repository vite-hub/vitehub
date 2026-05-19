import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, NetlifyBlobsStoreConfig } from "../types.ts"

export function createDriver(options: NetlifyBlobsStoreConfig): BlobDriverAdapter<NetlifyBlobsStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer<typeof import("files-sdk/netlify-blobs")>("files-sdk/netlify-blobs", options.driver, "files-sdk")).netlifyBlobs(options))
}
