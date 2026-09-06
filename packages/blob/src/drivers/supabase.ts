import { importOptionalPeer } from "../internal/optional-peer.ts"
import { getFilesSdkPeerInstall } from "../internal/files-sdk-peers.ts"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, SupabaseBlobStoreConfig } from "../types.ts"

export function createDriver(options: SupabaseBlobStoreConfig): BlobDriverAdapter<SupabaseBlobStoreConfig> {
  return createFilesSdkDriver(options, async (options) =>
    (await importOptionalPeer(() => import("files-sdk/supabase"), "files-sdk/supabase", options.driver, getFilesSdkPeerInstall(options.driver))).supabase(options))
}
