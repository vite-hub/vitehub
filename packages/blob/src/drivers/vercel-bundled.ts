import { createDriver } from "./vercel.ts"

import type { BlobDriverAdapter, ResolvedVercelBlobStoreConfig } from "../types.ts"

export function createBundledVercelBlobDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  return createDriver(options)
}
