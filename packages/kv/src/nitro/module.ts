import { createFeatureNitroBridge } from "@vitehub/internal/feature-bridge/engine"

import { kvFeatureEngine } from "../feature.ts"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "../types.ts"

const kvNitroModule = createFeatureNitroBridge(kvFeatureEngine)

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
