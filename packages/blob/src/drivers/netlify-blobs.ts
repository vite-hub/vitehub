import { Files } from "files-sdk"
import { netlifyBlobs } from "files-sdk/netlify-blobs"

import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, NetlifyBlobsStoreConfig } from "../types.ts"

export function createDriver(options: NetlifyBlobsStoreConfig): BlobDriverAdapter<NetlifyBlobsStoreConfig> {
  return createFilesSdkDriver(options, async options => netlifyBlobs(options), Files)
}
