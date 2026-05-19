import { supabase } from "files-sdk/supabase"
import { createFilesSdkDriver } from "./files-sdk.ts"

import type { BlobDriverAdapter, SupabaseBlobStoreConfig } from "../types.ts"

export function createDriver(options: SupabaseBlobStoreConfig): BlobDriverAdapter<SupabaseBlobStoreConfig> {
  return createFilesSdkDriver(options, supabase)
}
