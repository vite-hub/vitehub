import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, AkamaiBlobStoreConfig } from "../types.ts"

export function createDriver(options: AkamaiBlobStoreConfig): BlobDriverAdapter<AkamaiBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/akamai"), "files-sdk/akamai", options.driver, getFilesSdkPeerInstall(options.driver))).akamai(options))
}
