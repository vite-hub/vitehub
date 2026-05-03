import { resolveChat } from "./index.ts"
import { createChatRuntimeContext } from "./runtime/context.ts"

import type { Chat, StateAdapter, WebhookOptions } from "chat"
import type {
  ChatDurableObjectStateResolver,
  ChatInput,
  ChatRuntimeContext,
  ChatWaitUntil,
  CloudflareDurableObjectStateOptions,
} from "./types.ts"

export { ChatStateDO } from "chat-state-cloudflare-do"

type WebhookHandler = (request: Request, options?: WebhookOptions) => unknown
type CloudflareStateFactory = typeof import("chat-state-cloudflare-do")["createCloudflareState"]
type CloudflareStateFactoryOptions = Parameters<CloudflareStateFactory>[0]

class LazyCloudflareDurableObjectState implements StateAdapter {
  #adapter?: StateAdapter

  constructor(private readonly options: CloudflareStateFactoryOptions) {}

  async #getAdapter() {
    if (!this.#adapter) {
      const { createCloudflareState } = await import("chat-state-cloudflare-do")
      this.#adapter = createCloudflareState(this.options)
    }
    return this.#adapter
  }

  async connect() {
    await (await this.#getAdapter()).connect()
  }

  async disconnect() {
    await (await this.#getAdapter()).disconnect()
  }

  async subscribe(...args: Parameters<StateAdapter["subscribe"]>) {
    return await (await this.#getAdapter()).subscribe(...args)
  }

  async unsubscribe(...args: Parameters<StateAdapter["unsubscribe"]>) {
    return await (await this.#getAdapter()).unsubscribe(...args)
  }

  async isSubscribed(...args: Parameters<StateAdapter["isSubscribed"]>) {
    return await (await this.#getAdapter()).isSubscribed(...args)
  }

  async acquireLock(...args: Parameters<StateAdapter["acquireLock"]>) {
    return await (await this.#getAdapter()).acquireLock(...args)
  }

  async releaseLock(...args: Parameters<StateAdapter["releaseLock"]>) {
    return await (await this.#getAdapter()).releaseLock(...args)
  }

  async extendLock(...args: Parameters<StateAdapter["extendLock"]>) {
    return await (await this.#getAdapter()).extendLock(...args)
  }

  async forceReleaseLock(...args: Parameters<StateAdapter["forceReleaseLock"]>) {
    return await (await this.#getAdapter()).forceReleaseLock(...args)
  }

  async enqueue(...args: Parameters<StateAdapter["enqueue"]>) {
    return await (await this.#getAdapter()).enqueue(...args)
  }

  async dequeue(...args: Parameters<StateAdapter["dequeue"]>) {
    return await (await this.#getAdapter()).dequeue(...args)
  }

  async queueDepth(...args: Parameters<StateAdapter["queueDepth"]>) {
    return await (await this.#getAdapter()).queueDepth(...args)
  }

  async appendToList(...args: Parameters<StateAdapter["appendToList"]>) {
    return await (await this.#getAdapter()).appendToList(...args)
  }

  async getList<T = unknown>(...args: Parameters<StateAdapter["getList"]>) {
    return await (await this.#getAdapter()).getList<T>(...args)
  }

  async get<T = unknown>(...args: Parameters<StateAdapter["get"]>) {
    return await (await this.#getAdapter()).get<T>(...args)
  }

  async set(...args: Parameters<StateAdapter["set"]>) {
    return await (await this.#getAdapter()).set(...args)
  }

  async setIfNotExists(...args: Parameters<StateAdapter["setIfNotExists"]>) {
    return await (await this.#getAdapter()).setIfNotExists(...args)
  }

  async delete(...args: Parameters<StateAdapter["delete"]>) {
    return await (await this.#getAdapter()).delete(...args)
  }
}

function getWebhook(bot: Chat, platform: string): WebhookHandler | undefined {
  return (bot.webhooks as Record<string, WebhookHandler | undefined>)[platform]
}

function inferPlatform(request: Request): string | undefined {
  const pathname = new URL(request.url).pathname
  return pathname.split("/").filter(Boolean).at(-1)
}

export function cloudflareDurableObjectState(
  options: CloudflareDurableObjectStateOptions = {},
): ChatDurableObjectStateResolver {
  return {
    resolve(context) {
      const binding = options.binding || "CHAT_STATE"
      const namespace = context.cloudflare?.env?.[binding]
      if (!namespace) {
        throw new Error(
          `Missing Cloudflare Durable Object binding ${binding}. Configure chat.cloudflare.durableObjectState or wrangler durable_objects.`,
        )
      }

      return new LazyCloudflareDurableObjectState({
        locationHint: options.locationHint,
        name: options.name,
        namespace: namespace as CloudflareStateFactoryOptions["namespace"],
        shardKey: options.shardKey,
      })
    },
  }
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
