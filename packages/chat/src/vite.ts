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
  chatDevtoolsStreamChannel,
  chatDevtoolsTitle,
  chatDevtoolsUrlEnv,
} from "./devtools.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin, UserConfig } from "vite"
import type { ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type { ChatDevtoolsBridgeRequest, ChatDevtoolsSendResult, ChatDevtoolsStateResult, ChatDevtoolsStreamEvent } from "./devtools.ts"
import type { ChatModuleOptions } from "./types.ts"

export type ChatVitePlugin = Plugin & { nitro: NitroModule }

const chatPackageName = "@vitehub/chat"
const mergeNoExternal = createNoExternalMerger(chatPackageName)
const cloudflareWorkersDevAlias = new URL("./runtime/cloudflare-workers-dev.js", import.meta.url).pathname

function resolveChatDevtoolsClientDist(): string {
  return fileURLToPath(new URL("../dist/devtools-client", import.meta.url))
}

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

async function writeChatDevtoolsStream(
  ctx: ViteDevToolsNodeContext,
  body: ChatDevtoolsBridgeRequest,
  stream: { close: () => void, error: (error: unknown) => void, signal: AbortSignal, write: (event: ChatDevtoolsStreamEvent) => unknown },
): Promise<void> {
  try {
    const response = await fetch(new URL(chatDevtoolsBridgeRoute, resolveViteServerUrl(ctx)), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: stream.signal,
    })

    if (!response.ok) {
      throw new Error(`Chat DevTools bridge failed with ${response.status}: ${await response.text()}`)
    }
    if (!response.body) {
      throw new Error("Chat DevTools bridge did not return a stream.")
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let pending = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split("\n")
      pending = lines.pop() || ""
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as ChatDevtoolsStreamEvent
        if (event.type === "error") {
          stream.write(event)
          stream.close()
          return
        }
        if (event.type === "done") {
          stream.close()
          return
        }
        stream.write(event)
      }
    }
    const tail = pending.trim()
    if (tail) {
      stream.write(JSON.parse(tail) as ChatDevtoolsStreamEvent)
    }
    stream.close()
  }
  catch (cause) {
    if (!stream.signal.aborted) {
      stream.error(cause)
    }
  }
}

function registerChatDevtoolsRpc(ctx: ViteDevToolsNodeContext): void {
  const streaming = (ctx.rpc as { streaming?: { create: <T>(name: string, options?: { closedStreamRetention?: number, replayWindow?: number }) => { start: () => { close: () => void, error: (error: unknown) => void, id: string, signal: AbortSignal, write: (event: T) => unknown } } } }).streaming
  const chatStream = streaming?.create<ChatDevtoolsStreamEvent>(chatDevtoolsStreamChannel, {
    replayWindow: 1024,
    closedStreamRetention: 30_000,
  })

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
      handler: async (input): Promise<ChatDevtoolsSendResult> => {
        if (!chatStream) {
          throw new Error("Chat DevTools streaming requires a Vite DevTools version with ctx.rpc.streaming.")
        }
        const stream = chatStream.start()
        void writeChatDevtoolsStream(ctx, { action: "send", ...input }, stream)
        const state = await postChatDevtoolsBridge(ctx, { action: "get-state" })
        return {
          ...state,
          streamId: stream.id,
        }
      },
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
          distDir: resolveChatDevtoolsClientDist(),
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
