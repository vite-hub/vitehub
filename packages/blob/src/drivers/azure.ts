import { azure } from "files-sdk/azure"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, AzureBlobStoreConfig } from "../types.ts"

export function createDriver(options: AzureBlobStoreConfig): BlobDriverAdapter<AzureBlobStoreConfig> {
  return createFilesSdkDriver(options, azure)
}
