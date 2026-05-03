import { createError, defineEventHandler, getRouterParam, toRequest } from "h3"
import { createHooks } from "hookable"
import { useRuntimeConfig } from "nitro/runtime-config"

import { resolveChat } from "../index.ts"
import { createMemo } from "../runtime/context.ts"

import type { Chat, WebhookOptions } from "chat"
import type { EventHandler, H3Event } from "h3"
import type { NitroRuntimeConfig } from "nitro/types"
import type { ChatInput, ChatRuntimeContext, ChatWebhookHandlerOptions, ChatWebhookRuntimeHooks, ChatWaitUntil } from "../types.ts"

export interface NitroChatRuntimeContext extends ChatRuntimeContext {
  event: H3Event
  platform: string
  request: Request
  runtime: "nitro"
  runtimeConfig: NitroRuntimeConfig
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

function getCloudflareRuntime(event: H3Event): NitroChatRuntimeContext["cloudflare"] | undefined {
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
    env: runtime.env,
  }
}

function getChatWebhook(bot: Chat, platform: string): WebhookHandler | undefined {
  return (bot.webhooks as Record<string, WebhookHandler | undefined>)[platform]
}

function getRuntimeConfig(event: H3Event): NitroRuntimeConfig {
  return (useRuntimeConfig as unknown as (event?: H3Event) => NitroRuntimeConfig)(event)
}

function createHookRunner<TContext extends ChatRuntimeContext>(hooks: ChatWebhookRuntimeHooks<TContext> | undefined) {
  const runtimeHooks = createHooks<{
    error: (error: unknown, context: TContext) => void | Promise<void>
    request: (context: TContext) => void | Promise<void>
    resolved: (context: TContext & { bot: Chat }) => void | Promise<void>
    webhook: (context: TContext & { bot: Chat }) => void | Promise<void>
  }>()

  if (hooks?.request) runtimeHooks.hook("request", hooks.request)
  if (hooks?.resolved) runtimeHooks.hook("resolved", hooks.resolved)
  if (hooks?.webhook) runtimeHooks.hook("webhook", hooks.webhook)
  if (hooks?.error) runtimeHooks.hook("error", hooks.error)

  return runtimeHooks
}

export function defineChatWebhookHandler(
  chat: ChatInput<NitroChatRuntimeContext>,
  options: ChatWebhookHandlerOptions<NitroChatRuntimeContext> = {},
): EventHandler {
  const routeParam = options.routeParam || "platform"
  const hooks = createHookRunner(options.hooks)

  return defineEventHandler(async (event) => {
    const platform = options.platform || getRouterParam(event, routeParam)
    if (!platform) {
      throw createError({
        statusCode: 400,
        statusMessage: `Missing chat platform route param: ${routeParam}`,
      })
    }

    const waitUntil: ChatWaitUntil = task => event.waitUntil(task)
    const context: NitroChatRuntimeContext = {
      cloudflare: getCloudflareRuntime(event),
      event,
      memo: createMemo(),
      platform,
      request: toRequest(event.req),
      runtime: "nitro",
      runtimeConfig: getRuntimeConfig(event),
      waitUntil,
    }

    try {
      await hooks.callHook("request", context)
      const bot = await resolveChat(chat, context)
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
