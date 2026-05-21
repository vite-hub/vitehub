import { createRequire } from "node:module"
import { join } from "node:path"

import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { chatDevTools, chatDevToolsPanel } from "./devtools.ts"
import chatNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin, UserConfig } from "vite"
import type { ChatModuleOptions } from "./types.ts"

export type ChatVitePlugin = Plugin & { nitro: NitroModule }

const chatPackageName = "@vitehub/agent/chat"
const mergeNoExternal = createNoExternalMerger(chatPackageName)
const cloudflareWorkersDevAlias = new URL("./runtime/cloudflare-workers-dev.js", import.meta.url).pathname
const agentRequire = createRequire(import.meta.url)

function isChatDevtoolsEnabled(chat: ChatModuleOptions | false | undefined): boolean {
  return chat !== false && chat?.dev !== false && chat?.dev?.devtools !== false
}

function getChatDevtoolsOptions(chat: ChatModuleOptions | false | undefined): false | { url?: string } | undefined {
  return chat && chat.dev !== false && typeof chat.dev?.devtools === "object"
    ? chat.dev.devtools
    : undefined
}

function hasAlias(config: UserConfig, name: string): boolean {
  const alias = config.resolve?.alias
  if (!alias) {
    return false
  }

  if (Array.isArray(alias)) {
    return alias.some(entry => entry.find === name)
  }

  return name in alias
}

function resolveAppPackage(packageName: string, root: string | undefined): string | undefined {
  try {
    const base = root ? join(root, "package.json") : join(process.cwd(), "package.json")
    return createRequire(base).resolve(packageName)
  }
  catch {
    return undefined
  }
}

function resolveDevtoolsVueAlias(config: UserConfig): string {
  return resolveAppPackage("vue", config.root) ?? agentRequire.resolve("vue")
}

export function hubChat(options?: ChatModuleOptions): ChatVitePlugin {
  let chat: ChatModuleOptions | false | undefined = options

  return {
    name: "@vitehub/agent/chat/vite",
    nitro: {
      name: "@vitehub/agent/chat/vite",
      async setup(nitro) {
        await chatNitroModule.setup?.(nitro)
        const resolvedChat = (nitro.options as typeof nitro.options & { chat?: false | ChatModuleOptions }).chat ?? chat
        if (!isChatDevtoolsEnabled(resolvedChat)) {
          return
        }
        await chatDevTools({ devtools: getChatDevtoolsOptions(resolvedChat) }).nitro.setup?.(nitro)
      },
    },
    config(config, env) {
      chat = config.chat ?? chat
      const nextConfig: UserConfig = {}

      if (env.command === "serve") {
        const alias: Record<string, string> = {
          "cloudflare:workers": cloudflareWorkersDevAlias,
        }
        if (isChatDevtoolsEnabled(chat) && !hasAlias(config, "vue")) {
          alias.vue = resolveDevtoolsVueAlias(config)
        }

        nextConfig.resolve = {
          alias,
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

        chatDevToolsPanel({ devtools: getChatDevtoolsOptions(chat) }).devtools?.setup?.(ctx)
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
