import { createFeatureNitroBridge } from "@vite-hub/internal/feature-bridge"

import { kvFeatureEngine } from "../feature.ts"
import type { NitroModule } from "nitro/types"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "../types.ts"

const kvNitroModule: NitroModule = createFeatureNitroBridge(kvFeatureEngine)

export default kvNitroModule

declare module "nitro/types" {
  interface NitroOptions {
    cloudflare?: { wrangler?: { kv_namespaces?: { binding: string, id: string }[] } }
    kv?: KVModuleOptions
  }

  interface NitroConfig {
    kv?: KVModuleOptions
  }

  interface NitroRuntimeConfig {
    hosting?: string
    kv?: false | ResolvedKVModuleOptions
  }
}
