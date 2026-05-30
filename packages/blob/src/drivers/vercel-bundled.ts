import { Files } from "files-sdk"
import { vercelBlob } from "files-sdk/vercel-blob"

import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, BlobPutOptions, ResolvedVercelBlobStoreConfig } from "../types.ts"

export function createBundledVercelBlobDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  return createFilesSdkDriver(
    options,
    async (options, putOptions: BlobPutOptions = {}) => vercelBlob({
      ...options,
      access: putOptions.access || options.access,
      addRandomSuffix: false,
      allowOverwrite: options.allowOverwrite ?? true,
    }),
    Files,
  )
}
