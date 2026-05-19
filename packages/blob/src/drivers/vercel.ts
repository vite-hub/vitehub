import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, BlobPutOptions, ResolvedVercelBlobStoreConfig } from "../types.ts"

export function createDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options, putOptions: BlobPutOptions = {}) =>
    (await importOptionalPeer<typeof import("files-sdk/vercel-blob")>("files-sdk/vercel-blob", options.driver, "files-sdk")).vercelBlob({
      ...options,
      access: putOptions.access || options.access,
      addRandomSuffix: false,
      allowOverwrite: options.allowOverwrite ?? true,
    }))
}
