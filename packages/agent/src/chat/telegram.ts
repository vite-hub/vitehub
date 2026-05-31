import type {
  AgentCallbackContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { Adapter } from "chat"

export interface TelegramChatAdapterOptions {
  apiBaseUrl?: string
  apiUrl?: string
  botToken?: string
  logger?: unknown
  longPolling?: {
    allowedUpdates?: string[]
    deleteWebhook?: boolean
    dropPendingUpdates?: boolean
    limit?: number
    retryDelayMs?: number
    timeout?: number
  }
  mode?: "auto" | "webhook" | "polling"
  secretToken?: string
  userName?: string
}

export type TelegramChatAdapterOptionsResolver<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  | TelegramChatAdapterOptions
  | ((context: AgentCallbackContext<TRuntimeConfig>) => MaybePromise<TelegramChatAdapterOptions>)

function isMissingTelegramAdapter(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
    && error.message.includes("@chat-adapter/telegram")
}

async function createTelegramAdapter(options: TelegramChatAdapterOptions) {
  try {
    const adapter = await import("@chat-adapter/telegram")
    return adapter.createTelegramAdapter(options as never)
  }
  catch (error) {
    if (isMissingTelegramAdapter(error)) {
      throw new Error("[vitehub] @vite-hub/agent/chat/telegram requires @chat-adapter/telegram. Install it in your app before using the Telegram Chat Adapter Facade.")
    }
    throw error
  }
}

export function telegram<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: TelegramChatAdapterOptionsResolver<TRuntimeConfig>,
): (context: AgentCallbackContext<TRuntimeConfig>) => Promise<Adapter> {
  return async (context) => {
    const resolved = typeof options === "function" ? await options(context) : options
    return await createTelegramAdapter(resolved) as Adapter
  }
}
