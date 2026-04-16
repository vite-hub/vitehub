import kvNitroModule from "./nitro/module.ts"

import type { KVModuleOptions } from "./types.ts"
import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"

export type KVVitePlugin = Plugin & {
  nitro: NitroModule
}

export function hubKv(): KVVitePlugin {
  return {
    name: "@vitehub/kv/vite",
    nitro: kvNitroModule,
  } satisfies KVVitePlugin
}

declare module "vite" {
  interface UserConfig {
    kv?: KVModuleOptions
  }
}
