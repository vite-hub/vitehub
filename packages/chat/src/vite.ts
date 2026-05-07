import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import chatNitroModule from "./nitro/module.ts"
import { chatDevToolsPanel } from "./devtools.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin, UserConfig } from "vite"
import type { ChatModuleOptions } from "./types.ts"

export type ChatVitePlugin = Plugin & { nitro: NitroModule }

const chatPackageName = "@vitehub/chat"
const mergeNoExternal = createNoExternalMerger(chatPackageName)
const cloudflareWorkersDevAlias = new URL("./runtime/cloudflare-workers-dev.js", import.meta.url).pathname

function isChatDevtoolsEnabled(chat: ChatModuleOptions | false | undefined): boolean {
  return chat !== false && chat?.dev !== false && chat?.dev?.devtools !== false
}

export function hubChat(options?: ChatModuleOptions): ChatVitePlugin {
  let chat: ChatModuleOptions | false | undefined = options

  return {
    name: "@vitehub/chat/vite",
    nitro: chatNitroModule,
    config(config, env) {
      chat = config.chat ?? chat
      const nextConfig: UserConfig = {}

      if (env.command === "serve") {
        nextConfig.resolve = {
          alias: {
            "cloudflare:workers": cloudflareWorkersDevAlias,
          },
        }
      }

      if (typeof chat !== "undefined") {
        nextConfig.chat = chat
      }

      return Object.keys(nextConfig).length > 0 ? nextConfig : undefined
    },
    configResolved(config) {
      chat = config.chat ?? chat
    },
    devtools: {
      setup(ctx) {
        if (!isChatDevtoolsEnabled(chat)) {
          return
        }

        const devtools = chat && chat.dev !== false && typeof chat.dev?.devtools === "object"
          ? chat.dev.devtools
          : undefined
        chatDevToolsPanel({ devtools }).devtools?.setup?.(ctx)
      },
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
