import { importOptionalPeer } from "../internal/optional-peer.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, AkamaiBlobStoreConfig } from "../types.ts"

export function createDriver(options: AkamaiBlobStoreConfig): BlobDriverAdapter<AkamaiBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/akamai"), "files-sdk/akamai", options.driver, "files-sdk")).akamai(options))
}
