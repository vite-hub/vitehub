import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"
import { defineRpcFunction } from "@vitejs/devtools-kit"

import { normalizeChatOptions } from "./config.ts"
import {
  chatDevtoolsDockId,
  chatDevtoolsLocalUiRoute,
  chatDevtoolsRpcClear,
  chatDevtoolsRpcGetState,
  chatDevtoolsRpcSend,
  chatDevtoolsRoute,
  chatDevtoolsStateKey,
} from "./devtools.ts"
import chatNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { PluginWithDevTools, ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type { ResolvedConfig, UserConfig, ViteDevServer } from "vite"
import type { ChatDevtoolsChatParams, ChatDevtoolsRequest, ChatDevtoolsResult, ChatDevtoolsSendParams, ChatDevtoolsState } from "./devtools.ts"
import type { ChatModuleOptions } from "./types.ts"

export type ChatVitePlugin = PluginWithDevTools & { nitro: NitroModule }
export type ChatDevtoolsVitePlugin = PluginWithDevTools

declare module "@vitejs/devtools-kit" {
  interface DevToolsRpcSharedStates {
    "@vitehub/chat:state": ChatDevtoolsState
  }
}

const chatPackageName = "@vitehub/chat"
const mergeNoExternal = createNoExternalMerger(chatPackageName)
const cloudflareWorkersDevAlias = new URL("./runtime/cloudflare-workers-dev.js", import.meta.url).pathname
const missingDevtoolsWarning = [
  "[vitehub] Chat DevTools requires @vitejs/devtools. Add DevTools() before chatDevtools() in vite.config.ts:",
  "plugins: [DevTools(), chatDevtools(), nitro({ modules: ['@vitehub/chat/nitro'] })]",
].join("\n")
const chatDevtoolsPollingIntervalMs = 100
const chatDevtoolsMaxPollAttempts = 600

function isChatDevtoolsEnabled(chat: ChatModuleOptions | false | undefined): boolean {
  const resolved = normalizeChatOptions(chat)
  return !!(resolved && resolved.dev && resolved.dev.devtools)
}

function resolveChatDevtoolsUrl(chat: ChatModuleOptions | false | undefined): string {
  const resolved = normalizeChatOptions(chat)
  if (!resolved || !resolved.dev || !resolved.dev.devtools) {
    throw new Error("Chat DevTools is not enabled.")
  }
  return resolved.dev.devtools.url
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function flattenVitePlugins(plugins: unknown): unknown[] {
  if (!plugins) return []
  return Array.isArray(plugins) ? plugins.flatMap(flattenVitePlugins) : [plugins]
}

function hasViteDevtoolsPlugins(plugins: unknown): boolean {
  return flattenVitePlugins(plugins).some((plugin) => {
    return !!plugin && typeof plugin === "object" && "name" in plugin && typeof plugin.name === "string" && plugin.name.startsWith("vite:devtools:")
  })
}

function warnMissingViteDevtools(config: ResolvedConfig, chat: ChatModuleOptions | false | undefined): void {
  if (!isChatDevtoolsEnabled(chat) || hasViteDevtoolsPlugins(config.plugins)) {
    return
  }
  config.logger.warn(missingDevtoolsWarning)
}

function rewriteChatDevtoolsHtml(html: string, url: string): string {
  const origin = new URL(url).origin
  const routeNormalizationScript = `<script>if(location.pathname===${JSON.stringify(chatDevtoolsLocalUiRoute)})history.replaceState(history.state,"","/chat"+location.search+location.hash)</script>`
  return html
    .replaceAll(`"/_nuxt/`, `"${origin}/_nuxt/`)
    .replaceAll(`'/_nuxt/`, `'${origin}/_nuxt/`)
    .replace(/<script type="module"/, `${routeNormalizationScript}<script type="module"`)
    .replace(`cdnURL:""`, `cdnURL:${JSON.stringify(origin)}`)
}

function mountChatDevtoolsUi(server: ViteDevServer, getChat: () => ChatModuleOptions | false | undefined): void {
  server.middlewares.use(chatDevtoolsLocalUiRoute, async (_request, response, next) => {
    const chat = getChat()
    if (!isChatDevtoolsEnabled(chat)) {
      next()
      return
    }

    try {
      const url = resolveChatDevtoolsUrl(chat)
      const upstream = await fetch(url)
      if (!upstream.ok) {
        response.statusCode = upstream.status
        response.end(await upstream.text())
        return
      }

      response.setHeader("cache-control", "no-cache")
      response.setHeader("content-type", "text/html;charset=utf-8")
      response.end(rewriteChatDevtoolsHtml(await upstream.text(), url))
    }
    catch (error) {
      next(error)
    }
  })
}

function getDevtoolsBaseUrls(ctx: ViteDevToolsNodeContext): string[] {
  const urls: string[] = []
  const configuredPort = ctx.viteConfig.server.port
  if (configuredPort) {
    const host = typeof ctx.viteConfig.server.host === "string" ? ctx.viteConfig.server.host : "localhost"
    urls.push(`http://${host}:${configuredPort}`)
    urls.push(`http://127.0.0.1:${configuredPort}`)
    for (let port = configuredPort + 1; port <= configuredPort + 10; port++) {
      urls.push(`http://${host}:${port}`)
      urls.push(`http://127.0.0.1:${port}`)
    }
  }

  const localUrl = ctx.viteServer?.resolvedUrls?.local[0]
  if (localUrl) {
    urls.push(localUrl.endsWith("/") ? localUrl.slice(0, -1) : localUrl)
  }

  urls.push("http://localhost:5173", "http://127.0.0.1:5173")
  return uniqueStrings(urls)
}

async function postChatDevtoolsPayload(baseUrls: string[], payload: ChatDevtoolsRequest): Promise<ChatDevtoolsResult> {
  const errors: string[] = []
  for (const baseUrl of baseUrls) {
    const response = await fetch(`${baseUrl}${chatDevtoolsRoute}`, {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    }).catch((error: unknown) => {
      errors.push(`${baseUrl}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })

    if (!response) {
      continue
    }

    const contentType = response.headers.get("content-type") || ""
    if (!contentType.includes("application/json")) {
      errors.push(`${baseUrl}: expected JSON, received ${contentType || "unknown content type"}`)
      continue
    }

    const result = await response.json() as ChatDevtoolsResult
    if (response.ok && Array.isArray(result.messages) && Array.isArray(result.chats)) {
      return result
    }
    errors.push(`${baseUrl}: ${result.status || response.statusText || response.status}`)
  }

  return {
    chats: [],
    messages: [{
      author: "assistant",
      chat: "chat",
      id: "devtools-connect-error",
      text: `DevTools could not reach the chat bridge.\n\n${errors.join("\n")}`,
      threadId: "devtools:chat",
      timestamp: new Date().toISOString(),
    }],
    pending: false,
    status: "Connection failed",
  }
}

function createChatDevtoolsState(result?: ChatDevtoolsResult): ChatDevtoolsState {
  return {
    chatName: result?.chatName,
    chats: result?.chats || [],
    messages: result?.messages || [],
    pending: !!result?.pending,
    status: result?.status || "Ready",
  }
}

function updateChatDevtoolsState(state: { mutate: (fn: (draft: ChatDevtoolsState) => void) => void }, result: ChatDevtoolsResult): ChatDevtoolsState {
  const next = createChatDevtoolsState(result)
  state.mutate((draft) => {
    draft.chatName = next.chatName
    draft.chats = next.chats
    draft.messages = next.messages
    draft.pending = next.pending
    draft.status = next.status
  })
  return next
}

function shouldPollChatDevtoolsState(state: ChatDevtoolsState): boolean {
  if (state.pending) {
    return true
  }

  return state.messages.at(-1)?.author === "user"
}

async function setupChatDevtools(ctx: ViteDevToolsNodeContext, chat: ChatModuleOptions | false | undefined): Promise<void> {
  if (!isChatDevtoolsEnabled(chat)) {
    return
  }

  const baseUrls = getDevtoolsBaseUrls(ctx)
  const sharedState = await ctx.rpc.sharedState.get(chatDevtoolsStateKey, {
    initialValue: createChatDevtoolsState(),
  })
  const pollTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const normalizeChatName = (chatName: string) => chatName || "chat"
  const stopPolling = (chatName: string) => {
    const key = normalizeChatName(chatName)
    const timer = pollTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      pollTimers.delete(key)
    }
  }
  const refreshSharedState = async (payload: ChatDevtoolsRequest): Promise<ChatDevtoolsState> => {
    const result = await postChatDevtoolsPayload(baseUrls, payload)
    return updateChatDevtoolsState(sharedState, result)
  }
  const schedulePolling = (chatName: string, attemptsRemaining = chatDevtoolsMaxPollAttempts) => {
    const key = normalizeChatName(chatName)
    stopPolling(key)
    if (attemptsRemaining <= 0) {
      return
    }
    const timer = setTimeout(async () => {
      try {
        const next = await refreshSharedState({ chatName: key })
        if (shouldPollChatDevtoolsState(next)) {
          schedulePolling(key, attemptsRemaining - 1)
        }
      }
      catch {
        stopPolling(key)
      }
    }, chatDevtoolsPollingIntervalMs)
    pollTimers.set(key, timer)
  }
  ctx.docks.register({
    icon: "ph:chat-duotone",
    id: chatDevtoolsDockId,
    title: "Chat",
    type: "iframe",
    url: chatDevtoolsLocalUiRoute,
    remote: {
      originLock: false,
    },
  })
  ctx.rpc.register(defineRpcFunction({
    name: chatDevtoolsRpcGetState,
    type: "query",
    jsonSerializable: true,
    setup: () => ({
      handler: async (params: ChatDevtoolsChatParams = {}) => {
        const chatName = typeof params.chatName === "string" ? params.chatName.trim() : ""
        const result = await refreshSharedState({ chatName })
        if (shouldPollChatDevtoolsState(result)) {
          schedulePolling(result.chatName || chatName)
        }
        return result
      },
    }),
  }) as never)
  ctx.rpc.register(defineRpcFunction({
    name: chatDevtoolsRpcSend,
    type: "action",
    jsonSerializable: true,
    setup: () => ({
      handler: async (params: ChatDevtoolsSendParams) => {
        const chatName = typeof params.chatName === "string" ? params.chatName.trim() : ""
        const text = typeof params.text === "string" ? params.text : ""
        if (!text.trim()) {
          return await refreshSharedState({ chatName })
        }

        const result = await refreshSharedState({ chatName, stream: true, text })
        if (shouldPollChatDevtoolsState(result)) {
          schedulePolling(result.chatName || chatName)
        }
        return result
      },
    }),
  }) as never)
  ctx.rpc.register(defineRpcFunction({
    name: chatDevtoolsRpcClear,
    type: "action",
    jsonSerializable: true,
    setup: () => ({
      handler: async (params: ChatDevtoolsChatParams = {}) => {
        const chatName = typeof params.chatName === "string" ? params.chatName.trim() : ""
        stopPolling(chatName)
        return await refreshSharedState({ chatName, clear: true })
      },
    }),
  }) as never)
}

export function chatDevtools(options?: ChatModuleOptions): ChatDevtoolsVitePlugin {
  let chat: ChatModuleOptions | false | undefined = options

  return {
    name: "@vitehub/chat/devtools",
    devtools: {
      setup(ctx) {
        return setupChatDevtools(ctx, chat)
      },
    },
    configResolved(config) {
      chat = config.chat ?? chat
      warnMissingViteDevtools(config, chat)
    },
    configureServer(server) {
      mountChatDevtoolsUi(server, () => chat)
    },
  }
}

export function hubChat(options?: ChatModuleOptions): ChatVitePlugin {
  let chat: ChatModuleOptions | false | undefined = options

  return {
    name: "@vitehub/chat/vite",
    nitro: chatNitroModule,
    devtools: {
      setup(ctx) {
        return setupChatDevtools(ctx, chat)
      },
    },
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
      warnMissingViteDevtools(config, chat)
    },
    configureServer(server) {
      mountChatDevtoolsUi(server, () => chat)
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
