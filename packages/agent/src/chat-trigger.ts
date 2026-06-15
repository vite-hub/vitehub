import { defineCapability } from "./capability-runtime.ts"
import { createChatMessageTriggerInput } from "./chat-message-input.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentChatAgentHookArgs,
  AgentChatAdapterResolver,
  AgentChatFinishExtension,
  AgentChatOptions,
  AgentChatWebhookRegistrationDefinition,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
  AgentWebhookRegistrationDefinition,
} from "./types.ts"
import type { AgentChatMessageTriggerInput } from "./chat-message-input.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export type {
  AgentChatMessageTriggerInput,
  UIMessageLike,
} from "./chat-message-input.ts"

type ChatCapabilityMetadata<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> = {
  chat: AgentChatOptions<TRuntimeConfig>
  kind: "chat"
}

type ResolvedMaybeResolvable<T> =
  T extends (...args: any[]) => infer TResult
    ? Awaited<TResult>
    : T extends { resolve: (...args: any[]) => infer TResult }
      ? Awaited<TResult>
      : T

type AgentChatAdapterOrigin<TAdapters> =
  Extract<keyof NonNullable<ResolvedMaybeResolvable<TAdapters>>, string>

type AgentChatKnownOrigin<TOptions> =
  TOptions extends { adapters?: infer TAdapters } ? AgentChatAdapterOrigin<TAdapters> : never

export type AgentChatOptionsOrigin<TOptions> =
  [AgentChatKnownOrigin<TOptions>] extends [never]
    ? string
    : AgentChatKnownOrigin<TOptions>

type ChatCapabilityTypeContract<TOrigin extends string = string> = AgentCapabilityTypeContract & {
  chatOrigins: TOrigin
}

export type AgentChatCapabilityOrigin<TCapability> =
  TCapability extends AgentCapabilityDefinition<any, any, infer TTypeContract>
    ? TTypeContract extends { chatOrigins: infer TOrigin }
      ? Extract<TOrigin, string>
      : string
    : string

const CHAT_WEBHOOK_DEFAULTS = {
  telegram: {
    method: "POST",
    provider: "telegram",
    secretHeader: "x-telegram-bot-api-secret-token",
  },
} satisfies Record<string, Partial<AgentWebhookRegistrationDefinition> & { provider?: string }>

export const CHAT_FINISH_EXTENSION_CONTEXT_KEY = "chat.finish"

type KnownChatWebhookPlatform = keyof typeof CHAT_WEBHOOK_DEFAULTS

export interface AgentChatRunContext<
  TMessageMetadata extends object = Record<string, unknown>,
  TUser extends object = Record<string, unknown>,
  TOrigin extends string = string,
  TMeta extends object = Record<string, unknown>,
> {
  chat?: {
    message?: Omit<AgentChatAgentHookArgs["message"], "metadata"> & { metadata?: TMessageMetadata }
    meta?: TMeta
    run?: AgentRunMetadata<TOrigin>
    session?: AgentChatMessageTriggerInput["session"]
    user?: TUser
  }
}

async function resolveChatThinkingFallback<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig>,
  args: AgentChatAgentHookArgs<TRuntimeConfig>,
): Promise<string | undefined> {
  const fallback = options.fallbackStreamingPlaceholderText
  if (fallback === null) return undefined
  if (typeof fallback === "function") {
    const resolved = await fallback(args)
    return resolved || undefined
  }
  if (typeof fallback === "string") return fallback
  return undefined
}

function isResolvableObject(value: unknown): value is { resolve: (...args: never[]) => unknown } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function isStaticAdapterMap(value: AgentChatOptions["adapters"]): value is Record<string, AgentChatAdapterResolver> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !isResolvableObject(value)
}

function isKnownChatWebhookPlatform(platform: string): platform is KnownChatWebhookPlatform {
  return platform in CHAT_WEBHOOK_DEFAULTS
}

function hasExplicitChatWebhook(options: AgentChatOptions, platform: string): boolean {
  return !!options.webhooks && Object.prototype.hasOwnProperty.call(options.webhooks, platform)
}

function normalizeChatWebhookRegistrations(
  platform: string,
  input: AgentChatWebhookRegistrationDefinition | AgentChatWebhookRegistrationDefinition[],
): AgentWebhookRegistrationDefinition[] {
  const defaults: Partial<AgentWebhookRegistrationDefinition> & { provider?: string } = isKnownChatWebhookPlatform(platform)
    ? CHAT_WEBHOOK_DEFAULTS[platform]
    : { provider: platform }
  const registrations = Array.isArray(input) ? input : [input]
  return registrations.map((registration, index) => ({
    ...registration,
    id: registration.id || (registrations.length > 1 ? `${platform}-${index + 1}` : platform),
    method: registration.method || defaults.method || "POST",
    provider: registration.provider || defaults.provider || platform,
    secretHeader: registration.secretHeader || defaults.secretHeader,
  }))
}

function inferredChatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] {
  if (!isStaticAdapterMap(options.adapters)) return []
  return Object.keys(options.adapters)
    .filter(platform => !hasExplicitChatWebhook(options, platform))
    .flatMap(platform => normalizeChatWebhookRegistrations(platform, {}))
}

function explicitChatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] {
  return Object.entries(options.webhooks ?? {})
    .flatMap(([platform, input]) => normalizeChatWebhookRegistrations(platform, input))
}

export function chatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] | undefined {
  const registrations = [...explicitChatWebhookRegistrations(options), ...inferredChatWebhookRegistrations(options)]
  return registrations.length ? registrations : undefined
}

function createChatMessageTrigger<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig> = {},
): AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, AgentChatMessageTriggerInput> {
  return {
    devtools: true,
    input: "ui-message[]",
    output: "ui-message-stream",
    webhooks: chatWebhookRegistrations(options),
    async invoke(_context, triggerInput) {
      const { hookArgs, input } = createChatMessageTriggerInput(options, triggerInput)
      return {
        input,
        metadata: {
          thinkingFallback: await resolveChatThinkingFallback(options, hookArgs),
        },
        run: triggerInput.run,
      }
    },
  }
}

export function getChatCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  capabilities: AgentCapabilityDefinition[],
): AgentChatOptions<TRuntimeConfig> | undefined {
  return capabilities.find(capability => capability.id === "chat" && (capability.metadata as ChatCapabilityMetadata | undefined)?.kind === "chat")
    ?.metadata?.chat as AgentChatOptions<TRuntimeConfig> | undefined
}

export function chat<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  const TOptions extends AgentChatOptions<TRuntimeConfig> = AgentChatOptions<TRuntimeConfig>,
>(
  options: TOptions = {} as TOptions,
): AgentCapabilityDefinition<TRuntimeConfig, WorkspaceName, ChatCapabilityTypeContract<AgentChatOptionsOrigin<TOptions>>> {
  return defineCapability({
    id: "chat",
    metadata: {
      chat: options,
      kind: "chat",
    } satisfies ChatCapabilityMetadata<TRuntimeConfig>,
    prepare(context) {
      context.state.require("chat-history", { optional: true })
    },
    output(context) {
      context.finish.provide(() => context.context.get<AgentChatFinishExtension>(CHAT_FINISH_EXTENSION_CONTEXT_KEY))
    },
    triggers: {
      message: createChatMessageTrigger(options),
    },
  })
}
