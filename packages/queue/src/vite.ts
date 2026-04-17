import queueNitroModule from "./nitro/module.ts"

import type { QueueModuleOptions } from "./types.ts"
import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"

export type QueueVitePlugin = Plugin & {
  nitro: NitroModule
}

export function hubQueue(): QueueVitePlugin {
  return {
    name: "@vitehub/queue/vite",
    nitro: queueNitroModule,
  } satisfies QueueVitePlugin
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
