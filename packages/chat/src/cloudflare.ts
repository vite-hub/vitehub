import { ChatStateDO, createCloudflareState } from "chat-state-cloudflare-do"

import { resolveChat } from "./index.ts"
import { createChatRuntimeContext } from "./runtime/context.ts"

import type { Chat, StateAdapter, WebhookOptions } from "chat"
import type {
  ChatInput,
  ChatRuntimeContext,
  ChatWaitUntil,
  CloudflareDurableObjectStateOptions,
} from "./types.ts"

export { ChatStateDO }

type WebhookHandler = (request: Request, options?: WebhookOptions) => unknown

function getWebhook(bot: Chat, platform: string): WebhookHandler | undefined {
  return (bot.webhooks as Record<string, WebhookHandler | undefined>)[platform]
}

function inferPlatform(request: Request): string | undefined {
  const pathname = new URL(request.url).pathname
  return pathname.split("/").filter(Boolean).at(-1)
}

export function cloudflareDurableObjectState(
  context: ChatRuntimeContext,
  options: CloudflareDurableObjectStateOptions = {},
): StateAdapter {
  const binding = options.binding || "CHAT_STATE"
  const namespace = context.cloudflare?.env?.[binding]
  if (!namespace) {
    throw new Error(
      `Missing Cloudflare Durable Object binding ${binding}. Configure chat.cloudflare.durableObjectState or wrangler durable_objects.`,
    )
  }

  return createCloudflareState({
    locationHint: options.locationHint,
    name: options.name,
    namespace: namespace as Parameters<typeof createCloudflareState>[0]["namespace"],
    shardKey: options.shardKey,
  })
}

export function defineCloudflareChatHandler(
  chat: ChatInput<ChatRuntimeContext>,
  options: { platform?: string } = {},
): ExportedHandlerFetchHandler<Record<string, unknown>> {
  return async (request, env, executionContext) => {
    const platform = options.platform || inferPlatform(request)
    if (!platform) {
      return new Response("Missing chat platform.", { status: 400 })
    }

    const waitUntil: ChatWaitUntil = task => executionContext.waitUntil?.(task)
    const runtimeContext = createChatRuntimeContext({
      cloudflare: {
        context: executionContext,
        env,
      },
      platform,
      request,
      runtime: "cloudflare",
      waitUntil,
    })

    const bot = await resolveChat(chat, runtimeContext)
    const handler = getWebhook(bot, platform)
    if (!handler) {
      return new Response(`Unknown chat platform: ${platform}`, { status: 404 })
    }

    return await handler(request, { waitUntil }) as Response
  }
}
