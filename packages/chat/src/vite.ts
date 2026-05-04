import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"
import { defineRpcFunction } from "@vitejs/devtools-kit"
import { DEVTOOLS_DOCK_IMPORTS_VIRTUAL_ID, DEVTOOLS_MOUNT_PATH } from "@vitejs/devtools-kit/constants"

import { normalizeChatOptions } from "./config.ts"
import { chatDevtoolsRoute } from "./integrations/devtools.ts"
import chatNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { JsonRenderSpec, PluginWithDevTools, ViteDevToolsNodeContext } from "@vitejs/devtools-kit"
import type { UserConfig, ViteDevServer } from "vite"
import type { ChatModuleOptions } from "./types.ts"

export type ChatVitePlugin = PluginWithDevTools & { nitro: NitroModule }

const chatPackageName = "@vitehub/chat"
const mergeNoExternal = createNoExternalMerger(chatPackageName)
const cloudflareWorkersDevAlias = new URL("./runtime/cloudflare-workers-dev.js", import.meta.url).pathname
const chatDevtoolsDockId = "@vitehub/chat"
const chatDevtoolsClearAction = "@vitehub/chat:clear"
const chatDevtoolsSendAction = "@vitehub/chat:send"

interface ChatDevtoolsResult {
  chatName?: string
  chats?: string[]
  messages?: Array<{
    author: string
    chat: string
    id: string
    text: string
    timestamp: string
  }>
  status?: string
}

interface ChatDevtoolsState {
  chatName?: string
  message?: string
}

interface DevtoolsImportEntry {
  importFrom: string
  importName?: string
}

interface DevtoolsDockImportEntry {
  action?: DevtoolsImportEntry
  clientScript?: DevtoolsImportEntry
  id: string
  renderer?: DevtoolsImportEntry
  type: string
}

function isChatDevtoolsEnabled(chat: ChatModuleOptions | false | undefined): boolean {
  const resolved = normalizeChatOptions(chat)
  return !!(resolved && resolved.dev && resolved.dev.devtools)
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

async function createChatDevtoolsMiddleware(devServer: ViteDevServer, context: ViteDevToolsNodeContext): Promise<unknown> {
  try {
    const { createDevToolsMiddleware } = await import("@vitejs/devtools")
    const host = devServer.config.server.host === true ? "0.0.0.0" : devServer.config.server.host || "localhost"
    const { middleware } = await createDevToolsMiddleware({
      context,
      cwd: devServer.config.root,
      websocket: { host },
    } as never)
    return middleware
  }
  catch (error) {
    throw new Error(
      "Chat DevTools requires @vitejs/devtools. Install it or disable chat devtools with hubChat({ dev: { devtools: false } }).",
      { cause: error },
    )
  }
}

async function createChatDevtoolsContext(devServer: ViteDevServer): Promise<ViteDevToolsNodeContext> {
  try {
    const { createDevToolsContext } = await import("@vitejs/devtools")
    return await createDevToolsContext(devServer.config as never, devServer as never) as ViteDevToolsNodeContext
  }
  catch (error) {
    throw new Error(
      "Chat DevTools requires @vitejs/devtools. Install it or disable chat devtools with hubChat({ dev: { devtools: false } }).",
      { cause: error },
    )
  }
}

function renderDockImportsMap(docks: Iterable<DevtoolsDockImportEntry>): string {
  const imports = new Map<string, DevtoolsImportEntry>()
  for (const dock of docks) {
    const id = `${dock.type}:${dock.id}`
    if (dock.type === "action" && dock.action) imports.set(id, dock.action)
    else if (dock.type === "custom-render" && dock.renderer) imports.set(id, dock.renderer)
    else if (dock.type === "iframe" && dock.clientScript) imports.set(id, dock.clientScript)
  }
  return [
    "export const importsMap = {",
    ...[...imports.entries()].map(([id, entry]) => `  [${JSON.stringify(id)}]: () => import(${JSON.stringify(entry.importFrom)}).then(r => r[${JSON.stringify(entry.importName ?? "default")}]),`),
    "}",
  ].join("\n")
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

async function postChatDevtoolsPayload(baseUrls: string[], payload: unknown): Promise<ChatDevtoolsResult> {
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
    if (response.ok && (Array.isArray(result.messages) || Array.isArray(result.chats))) {
      return result
    }
    errors.push(`${baseUrl}: ${result.status || response.statusText || response.status}`)
  }

  return {
    messages: [{
      author: "assistant",
      chat: "chat",
      id: "devtools-connect-error",
      text: `DevTools could not reach the chat bridge.\n\n${errors.join("\n")}`,
      timestamp: new Date().toISOString(),
    }],
    status: "Connection failed",
  }
}

function formatChatDevtoolsTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })
}

function createChatDevtoolsMessageParagraphs(messageId: string, text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)

  return paragraphs.length > 0 ? paragraphs.map((_, index) => `${messageId}-paragraph-${index}`) : [`${messageId}-paragraph-0`]
}

function resolveChatDevtoolsChatName(result: ChatDevtoolsResult, state: ChatDevtoolsState): string {
  return state.chatName || result.chatName || result.messages?.[0]?.chat || result.chats?.[0] || "chat"
}

function buildChatDevtoolsSpec(result: ChatDevtoolsResult = {}, state: ChatDevtoolsState = {}): JsonRenderSpec {
  const elements: JsonRenderSpec["elements"] = {}
  const messages = result.messages || []
  const messageStateKey = `message-${messages.length}`
  const chatNameStateKey = "chat-name"
  const chatName = resolveChatDevtoolsChatName(result, state)
  const messageElements = messages.map((message) => {
    const align = message.author === "user" ? "end" : "start"
    const title = `${message.author === "user" ? "You" : "Assistant"} ${formatChatDevtoolsTime(message.timestamp)}`
    const paragraphIds = createChatDevtoolsMessageParagraphs(message.id, message.text)
    const paragraphTexts = message.text
      .split(/\n{2,}/)
      .map(paragraph => paragraph.trim())
      .filter(Boolean)
    const resolvedParagraphTexts = paragraphTexts.length > 0 ? paragraphTexts : [""]

    for (const [index, paragraphId] of paragraphIds.entries()) {
      elements[paragraphId] = {
        props: {
          content: resolvedParagraphTexts[index],
          variant: "body",
        },
        type: "Text",
      }
    }

    elements[`${message.id}-card`] = {
      children: paragraphIds,
      props: { title },
      type: "Card",
    }
    elements[message.id] = {
      children: [`${message.id}-card`],
      props: { align, direction: "vertical", gap: 4 },
      type: "Stack",
    }
    return message.id
  })

  if (messageElements.length === 0) {
    elements.empty = {
      props: {
        content: "No messages yet.",
        variant: "caption",
      },
      type: "Text",
    }
    messageElements.push("empty")
  }

  const mainChildren = messages.length > 0 ? ["topbar", "transcript"] : ["transcript"]
  const composerChildren = result.chats && result.chats.length > 1 ? ["chat-input", "available-chats", "composer-row"] : ["chat-input", "composer-row"]

  return {
    elements: {
      ...elements,
      "available-chats": {
        props: {
          content: `Available chats: ${result.chats?.join(", ")}`,
          variant: "caption",
        },
        type: "Text",
      },
      "chat-input": {
        props: {
          label: "Chat",
          placeholder: "chat",
          value: { $bindState: `/${chatNameStateKey}` },
        },
        type: "TextInput",
      },
      "clear-button": {
        on: {
          press: {
            action: chatDevtoolsClearAction,
            params: {
              chatName: { $state: `/${chatNameStateKey}` },
            },
          },
        },
        props: {
          icon: "ph:trash",
          variant: "ghost",
        },
        type: "Button",
      },
      "composer": {
        children: composerChildren,
        props: { direction: "vertical", gap: 8 },
        type: "Stack",
      },
      "composer-row": {
        children: ["message-input", "send-button"],
        props: { align: "end", direction: "horizontal", gap: 8 },
        type: "Stack",
      },
      "message-input": {
        props: {
          placeholder: "Type a message...",
          value: { $bindState: `/${messageStateKey}` },
        },
        type: "TextInput",
      },
      "main": {
        children: mainChildren,
        props: { direction: "vertical", gap: 8 },
        type: "Stack",
      },
      "root": {
        children: ["main", "composer"],
        props: { direction: "vertical", gap: 12, justify: "space-between", padding: 8 },
        type: "Stack",
      },
      "send-button": {
        on: {
          press: {
            action: chatDevtoolsSendAction,
            params: {
              chatName: { $state: `/${chatNameStateKey}` },
              text: { $state: `/${messageStateKey}` },
            },
          },
        },
        props: {
          icon: "ph:paper-plane-tilt",
          label: "Send",
          variant: "primary",
        },
        type: "Button",
      },
      "transcript": {
        children: messageElements,
        props: { direction: "vertical", gap: 8 },
        type: "Stack",
      },
      "topbar": {
        children: ["clear-button"],
        props: { direction: "horizontal", justify: "end" },
        type: "Stack",
      },
    },
    root: "root",
    state: {
      [chatNameStateKey]: chatName,
      [messageStateKey]: state.message || "",
    },
  }
}

export function hubChat(options?: ChatModuleOptions): ChatVitePlugin {
  let chat: ChatModuleOptions | false | undefined = options
  let devtoolsContext: ViteDevToolsNodeContext | undefined

  return {
    name: "@vitehub/chat/vite",
    nitro: chatNitroModule,
    devtools: {
      setup(ctx) {
        if (!isChatDevtoolsEnabled(chat)) {
          return
        }

        const ui = ctx.createJsonRenderer(buildChatDevtoolsSpec())
        const baseUrls = getDevtoolsBaseUrls(ctx)
        ctx.docks.register({
          icon: "ph:chat-duotone",
          id: chatDevtoolsDockId,
          title: "Chat",
          type: "json-render",
          ui,
        })
        ctx.rpc.register(defineRpcFunction({
          name: chatDevtoolsSendAction,
          type: "action",
          setup: () => ({
            handler: async (params: { chatName?: string, text?: string }) => {
              const chatName = typeof params.chatName === "string" ? params.chatName.trim() : ""
              const text = typeof params.text === "string" ? params.text : ""
              if (!text.trim()) {
                return
              }

              const result = await postChatDevtoolsPayload(baseUrls, { chatName, text })
              await ui.updateState({})
              await ui.updateSpec(buildChatDevtoolsSpec(result, { chatName: result.chatName || chatName, message: "" }))
            },
          }),
        }) as never)
        ctx.rpc.register(defineRpcFunction({
          name: chatDevtoolsClearAction,
          type: "action",
          setup: () => ({
            handler: async (params: { chatName?: string } = {}) => {
              const chatName = typeof params.chatName === "string" ? params.chatName.trim() : ""
              const result = await postChatDevtoolsPayload(baseUrls, { chatName, clear: true })
              await ui.updateState({})
              await ui.updateSpec(buildChatDevtoolsSpec(result, { chatName: result.chatName || chatName, message: "" }))
            },
          }),
        }) as never)
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
        if (isChatDevtoolsEnabled(chat)) {
          nextConfig.devtools = { enabled: true }
        }
      }

      if (typeof chat !== "undefined") {
        nextConfig.chat = chat
      }

      return Object.keys(nextConfig).length > 0 ? nextConfig : undefined
    },
    async configureServer(devServer) {
      if (!isChatDevtoolsEnabled(chat) || hasViteDevtoolsPlugins(devServer.config.plugins)) return

      devtoolsContext = await createChatDevtoolsContext(devServer)
      devServer.middlewares.use(DEVTOOLS_MOUNT_PATH, await createChatDevtoolsMiddleware(devServer, devtoolsContext) as never)
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
    resolveId(id) {
      if (id === DEVTOOLS_DOCK_IMPORTS_VIRTUAL_ID) return id
    },
    load(id) {
      if (id !== DEVTOOLS_DOCK_IMPORTS_VIRTUAL_ID) return
      if (!devtoolsContext) throw new Error("Chat DevTools context is not initialized.")
      return renderDockImportsMap(devtoolsContext.docks.values() as Iterable<DevtoolsDockImportEntry>)
    },
  }
}

declare module "vite" {
  interface UserConfig {
    chat?: false | ChatModuleOptions
  }
}
