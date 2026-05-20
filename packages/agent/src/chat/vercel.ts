import { waitUntil as vercelWaitUntil } from "@vercel/functions"

import { resolveChat } from "./index.ts"
import { createChatRuntimeContext } from "./runtime/context.ts"

import type { Chat, WebhookOptions } from "chat"
import type { ChatInput, ChatRuntimeContext, ChatWaitUntil } from "./types.ts"

type WebhookHandler = (request: Request, options?: WebhookOptions) => unknown

function getWebhook(bot: Chat, platform: string): WebhookHandler | undefined {
  return (bot.webhooks as Record<string, WebhookHandler | undefined>)[platform]
}

function inferPlatform(request: Request): string | undefined {
  const pathname = new URL(request.url).pathname
  return pathname.split("/").filter(Boolean).at(-1)
}

export function defineVercelChatHandler(
  chat: ChatInput<ChatRuntimeContext>,
  options: { platform?: string, waitUntil?: ChatWaitUntil } = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const platform = options.platform || inferPlatform(request)
    if (!platform) {
      return new Response("Missing chat platform.", { status: 400 })
    }

    const waitUntil = options.waitUntil || vercelWaitUntil
    const runtimeContext = createChatRuntimeContext({
      platform,
      request,
      runtime: "vercel",
      vercel: { waitUntil },
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
