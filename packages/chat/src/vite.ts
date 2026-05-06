import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"
import { registerViteHubDevtoolsPanel } from "@vitehub/devtools"
import { defineRpcFunction } from "@vitejs/devtools-kit"
import { fileURLToPath } from "node:url"

import chatNitroModule from "./nitro/module.ts"
import {
  chatDevtoolsBridgeRoute,
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsPanelId,
  chatDevtoolsRoute,
  chatDevtoolsSendRpc,
  chatDevtoolsTitle,
  chatDevtoolsUrlEnv,
} from "./devtools.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin, UserConfig } from "vite"
import type { ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type { ChatDevtoolsBridgeRequest, ChatDevtoolsStateResult } from "./devtools.ts"
import type { ChatModuleOptions } from "./types.ts"

export type ChatVitePlugin = Plugin & { nitro: NitroModule }

const chatPackageName = "@vitehub/chat"
const mergeNoExternal = createNoExternalMerger(chatPackageName)
const cloudflareWorkersDevAlias = new URL("./runtime/cloudflare-workers-dev.js", import.meta.url).pathname
const chatDevtoolsClientDist = fileURLToPath(new URL("../dist/devtools-client", import.meta.url))

function isChatDevtoolsEnabled(chat: ChatModuleOptions | false | undefined): boolean {
  return chat !== false && chat?.dev !== false && chat?.dev?.devtools !== false
}

function resolveChatDevtoolsUrl(chat: ChatModuleOptions | false | undefined): string | undefined {
  if (chat === false || chat?.dev === false || chat?.dev?.devtools === false) {
    return
  }
  if (process.env[chatDevtoolsUrlEnv]) {
    return process.env[chatDevtoolsUrlEnv]
  }
  return typeof chat?.dev?.devtools === "object" ? chat.dev.devtools.url : undefined
}

function resolveViteServerUrl(ctx: ViteDevToolsNodeContext): string {
  const localUrl = ctx.viteServer?.resolvedUrls?.local?.[0]
  if (localUrl) {
    return localUrl
  }

  const address = ctx.viteServer?.httpServer?.address()
  if (typeof address === "object" && address?.port) {
    return `http://localhost:${address.port}/`
  }

  const port = ctx.viteConfig.server.port || 5173
  return `http://localhost:${port}/`
}

async function postChatDevtoolsBridge(ctx: ViteDevToolsNodeContext, body: ChatDevtoolsBridgeRequest): Promise<ChatDevtoolsStateResult> {
  const response = await fetch(new URL(chatDevtoolsBridgeRoute, resolveViteServerUrl(ctx)), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Chat DevTools bridge failed with ${response.status}: ${await response.text()}`)
  }

  return await response.json() as ChatDevtoolsStateResult
}

function registerChatDevtoolsRpc(ctx: ViteDevToolsNodeContext): void {
  ctx.rpc.register(defineRpcFunction({
    name: chatDevtoolsGetStateRpc,
    type: "query",
    jsonSerializable: true,
    setup: () => ({
      handler: async () => await postChatDevtoolsBridge(ctx, { action: "get-state" }),
    }),
  }) as never)

  ctx.rpc.register(defineRpcFunction({
    name: chatDevtoolsSendRpc,
    type: "action",
    jsonSerializable: true,
    setup: () => ({
      handler: async input => await postChatDevtoolsBridge(ctx, { action: "send", ...input }),
    }),
  }) as never)

  ctx.rpc.register(defineRpcFunction({
    name: chatDevtoolsClearRpc,
    type: "action",
    jsonSerializable: true,
    setup: () => ({
      handler: async input => await postChatDevtoolsBridge(ctx, { action: "clear", ...input }),
    }),
  }) as never)
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

        registerViteHubDevtoolsPanel(ctx, {
          distDir: chatDevtoolsClientDist,
          icon: "i-lucide-message-square",
          id: chatDevtoolsPanelId,
          route: chatDevtoolsRoute,
          title: chatDevtoolsTitle,
          url: resolveChatDevtoolsUrl(chat),
        })
        registerChatDevtoolsRpc(ctx)
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
