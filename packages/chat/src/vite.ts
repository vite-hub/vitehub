import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import chatNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"
import type { ChatModuleOptions } from "./types.ts"

export type ChatVitePlugin = Plugin & { nitro: NitroModule }

const chatPackageName = "@vitehub/chat"
const mergeNoExternal = createNoExternalMerger(chatPackageName)

export function hubChat(options?: ChatModuleOptions): ChatVitePlugin {
  let chat: ChatModuleOptions | false | undefined = options

  return {
    name: "@vitehub/chat/vite",
    nitro: chatNitroModule,
    config(config) {
      chat = config.chat ?? chat
      if (typeof chat !== "undefined") {
        return { chat }
      }
    },
    configResolved(config) {
      chat = config.chat ?? chat
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
  }
}

declare module "vite" {
  interface UserConfig {
    chat?: false | ChatModuleOptions
  }
}
