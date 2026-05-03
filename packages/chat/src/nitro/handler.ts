import { createError, defineEventHandler, getRouterParam } from "h3"
import { createHooks } from "hookable"

import { resolveChat } from "../index.ts"
import { createMemo } from "../runtime/context.ts"
import { getChatDefinitionLifecycleHooks } from "../runtime/definition.ts"
import { getChatRuntimeConfig } from "../runtime/nitro-runtime-config.ts"

import type { Chat, WebhookOptions } from "chat"
import type { EventHandler, H3Event } from "h3"
import type { NitroRuntimeConfig } from "nitro/types"
import type { ChatInput, ChatRuntimeConfig, ChatRuntimeContext, ChatWebhookHandlerOptions, ChatWebhookRegistryHandlerOptions, ChatWebhookRuntimeHooks, ChatWaitUntil } from "../types.ts"

export interface NitroChatRuntimeConfig extends NitroRuntimeConfig, ChatRuntimeConfig {}

export interface NitroChatRuntimeContext extends ChatRuntimeContext<NitroChatRuntimeConfig> {
  event: H3Event
  platform: string
  request: Request
  runtime: "nitro"
  runtimeConfig: NitroChatRuntimeConfig
}

type WebhookHandler = (request: Request, options?: WebhookOptions) => unknown

interface CloudflareRuntimeCarrier {
  context?: {
    cloudflare?: {
      context?: unknown
      env?: Record<string, unknown>
    }
  }
  runtime?: {
    cloudflare?: {
      context?: unknown
      env?: Record<string, unknown>
    }
  }
}

function getCloudflareRuntime(event: H3Event, runtimeConfig: NitroRuntimeConfig): NitroChatRuntimeContext["cloudflare"] | undefined {
  const carrier = event as CloudflareRuntimeCarrier
  const requestCarrier = event.req as CloudflareRuntimeCarrier
  const runtime = carrier.context?.cloudflare
    || carrier.runtime?.cloudflare
    || requestCarrier.context?.cloudflare
    || requestCarrier.runtime?.cloudflare

  if (!runtime) {
    return undefined
  }

  return {
    context: runtime.context,
    durableObjectStateName: (runtimeConfig.chat as { cloudflare?: { durableObjectState?: { name?: string } } } | undefined)?.cloudflare?.durableObjectState?.name,
    env: runtime.env,
  }
}

function getChatWebhook(bot: Chat, platform: string): WebhookHandler | undefined {
  return (bot.webhooks as Record<string, WebhookHandler | undefined>)[platform]
}

function getRuntimeConfig(event: H3Event): NitroChatRuntimeConfig {
  return getChatRuntimeConfig(event) as NitroChatRuntimeConfig
}

function createHookRunner<TContext extends ChatRuntimeContext>(...hooksList: Array<ChatWebhookRuntimeHooks<TContext> | undefined>) {
  const runtimeHooks = createHooks<{
    error: (error: unknown, context: TContext) => void | Promise<void>
    request: (context: TContext) => void | Promise<void>
    resolved: (context: TContext & { bot: Chat }) => void | Promise<void>
    webhook: (context: TContext & { bot: Chat }) => void | Promise<void>
  }>()

  for (const hooks of hooksList) {
    if (hooks?.request) runtimeHooks.hook("request", hooks.request)
    if (hooks?.resolved) runtimeHooks.hook("resolved", hooks.resolved)
    if (hooks?.webhook) runtimeHooks.hook("webhook", hooks.webhook)
    if (hooks?.error) runtimeHooks.hook("error", hooks.error)
  }

  return runtimeHooks
}

export function defineChatWebhookHandler(
  chat: ChatInput<NitroChatRuntimeContext>,
  options: ChatWebhookHandlerOptions<NitroChatRuntimeContext> = {},
): EventHandler {
  const routeParam = options.routeParam || "platform"
  const hooks = createHookRunner(getChatDefinitionLifecycleHooks(chat), options.lifecycleHooks)

  return defineEventHandler(async (event) => {
    const platform = options.platform || getRouterParam(event, routeParam)
    if (!platform) {
      throw createError({
        statusCode: 400,
        statusMessage: `Missing chat platform route param: ${routeParam}`,
      })
    }

    const runtimeConfig = getRuntimeConfig(event)
    const waitUntil: ChatWaitUntil = task => event.waitUntil(task)
    const context: NitroChatRuntimeContext = {
      cloudflare: getCloudflareRuntime(event, runtimeConfig),
      event,
      memo: createMemo(),
      platform,
      request: event.req as Request,
      runtime: "nitro",
      runtimeConfig,
      waitUntil,
    }

    try {
      await hooks.callHook("request", context)
      const bot = await resolveChat(chat, context, { inferredName: options.inferredName })
      await hooks.callHook("resolved", { ...context, bot })

      const handler = getChatWebhook(bot, platform)
      if (!handler) {
        throw createError({
          statusCode: 404,
          statusMessage: `Unknown chat platform: ${platform}`,
        })
      }

      await hooks.callHook("webhook", { ...context, bot })
      return await handler(context.request, { waitUntil })
    }
    catch (error) {
      await hooks.callHook("error", error, context)
      throw error
    }
  })
}

type ChatRegistryModule = { default?: ChatInput<NitroChatRuntimeContext> } | ChatInput<NitroChatRuntimeContext>
type ChatRegistry = Record<string, () => Promise<ChatRegistryModule>>

function resolveRegistryModule(module: ChatRegistryModule): ChatInput<NitroChatRuntimeContext> {
  return typeof module === "object" && module !== null && "default" in module
    ? module.default as ChatInput<NitroChatRuntimeContext>
    : module as ChatInput<NitroChatRuntimeContext>
}

export function defineChatWebhookRegistryHandler(
  chats: ChatRegistry,
  options: ChatWebhookRegistryHandlerOptions<NitroChatRuntimeContext> = {},
): EventHandler {
  const chatParam = options.chatParam || "chat"

  return defineEventHandler(async (event) => {
    const chatName = getRouterParam(event, chatParam)
    if (!chatName) {
      throw createError({
        statusCode: 400,
        statusMessage: `Missing chat route param: ${chatParam}`,
      })
    }

    const loader = chats[chatName]
    if (!loader) {
      throw createError({
        statusCode: 404,
        statusMessage: `Unknown chat: ${chatName}`,
      })
    }

    const chat = resolveRegistryModule(await loader())
    return await defineChatWebhookHandler(chat, {
      ...options,
      inferredName: options.inferredName || chatName,
    })(event)
  })
}
