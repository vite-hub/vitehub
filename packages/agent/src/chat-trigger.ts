import { defineCapability } from "./capability-runtime.ts"
import { createChatMessageTriggerInput } from "./chat-message-input.ts"
import { toAgentPublicError } from "./agent-error.ts"
import { createReplyDeliveryEffectIntent, defineFinishEffect } from "./delivery-effects.ts"
import { agentWorkflowExecutionContextKey } from "./internal/workflow-execution.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentChatAgentHookArgs,
  AgentChatErrorHookArgs,
  AgentChatCapabilityOptions,
  AgentChatFinishExtension,
  AgentChatOptions,
  AgentChatPlatformResolver,
  AgentChannelDeliveryEffectIntent,
  AgentChannelWebhookRegistrationDefinition,
  AgentInvocationContextStore,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
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

type AgentChatPlatformOrigin<TPlatforms> =
  Extract<keyof NonNullable<ResolvedMaybeResolvable<TPlatforms>>, string>

type AgentChatKnownOrigin<TOptions> =
  TOptions extends { platforms?: infer TPlatforms } ? AgentChatPlatformOrigin<TPlatforms> : never

export type AgentChatOptionsOrigin<TOptions> =
  [AgentChatKnownOrigin<TOptions>] extends [never]
    ? string
    : AgentChatKnownOrigin<TOptions>

export const agentChatContextKey = "chat"

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
const defaultChatErrorFallbackText = "Sorry, I couldn't process that message."
const durableChatErrorFallbackTimeoutMs = 30_000
export function isDurableChatErrorFallbackEffect(effect: unknown): boolean {
  return typeof effect === "function" && (effect as { kind?: string }).kind === "chat.error-fallback"
}

export function durableChatErrorFallbackTimeout(
  options: Pick<AgentChatOptions, "timeout"> | undefined,
): number {
  return Math.min(options?.timeout ?? durableChatErrorFallbackTimeoutMs, durableChatErrorFallbackTimeoutMs)
}

type KnownChatWebhookPlatform = keyof typeof CHAT_WEBHOOK_DEFAULTS

export async function resolveChatErrorFallbackText<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig> | undefined,
  args: AgentChatErrorHookArgs<TRuntimeConfig>,
  callbackDelivered?: () => boolean,
  resolveFallback?: (fallback: Promise<unknown>) => Promise<unknown>,
): Promise<string | undefined> {
  const fallback = options?.errorFallbackText
  if (fallback === null) return
  if (typeof fallback === "function") {
    try {
      const resolution = Promise.resolve(fallback(args))
      return await (resolveFallback ? resolveFallback(resolution) : resolution) as string || undefined
    }
    catch {
      return callbackDelivered?.() ? undefined : defaultChatErrorFallbackText
    }
  }
  if (args.publicError.code !== "INTERNAL") return args.publicError.error
  return typeof fallback === "string" ? fallback : defaultChatErrorFallbackText
}

export function resolveDurableChatErrorFallbackText<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig> | undefined,
  args: AgentChatErrorHookArgs<TRuntimeConfig>,
  callbackDelivered?: () => boolean,
): Promise<string | undefined> {
  const timeout = durableChatErrorFallbackTimeout(options)
  return resolveChatErrorFallbackText(options, args, callbackDelivered, async (resolution) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        resolution,
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`Durable chat error fallback timed out after ${timeout}ms.`)), timeout)
        }),
      ])
    }
    finally {
      if (timeoutId) clearTimeout(timeoutId)
    }
  })
}

export async function resolveDurableChatErrorFallbackIntents<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig> | undefined,
  args: Omit<AgentChatErrorHookArgs<TRuntimeConfig>, "thread">,
  resolveFallback?: (fallback: Promise<unknown>) => Promise<unknown>,
): Promise<AgentChannelDeliveryEffectIntent[]> {
  const intents: AgentChannelDeliveryEffectIntent[] = []
  let acceptingIntents = true
  const hookArgs = {
    ...args,
    thread: {
      post: async (message: unknown) => {
        if (!acceptingIntents) throw new Error("Durable chat error fallback resolution has already completed.")
        intents.push(createReplyDeliveryEffectIntent(message as never, { intent: "chat.error-fallback" }))
      },
    },
  } as AgentChatErrorHookArgs<TRuntimeConfig>
  const fallback = resolveFallback
    ? await resolveChatErrorFallbackText(options, hookArgs, () => intents.length > 0, resolveFallback)
    : await resolveDurableChatErrorFallbackText(options, hookArgs, () => intents.length > 0)
  acceptingIntents = false
  if (!intents.length && fallback) intents.push(createReplyDeliveryEffectIntent(fallback, { intent: "chat.error-fallback" }))
  return intents
}

function durableChatErrorFallback<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig>,
) {
  const effect = defineFinishEffect<TRuntimeConfig>(async (context) => {
    if (context.error === undefined || !(context as unknown as AgentRuntimeContext & { [agentWorkflowExecutionContextKey]?: boolean })[agentWorkflowExecutionContextKey]) return
    const chat = getAgentChatContext(context.context)
    const channel = context.context.get<AgentChannelContext>("channel")
    if (!chat && !channel) return
    return await resolveDurableChatErrorFallbackIntents(options, {
      error: context.error,
      history: context.input.messages || [],
      message: chat?.message || channel?.message || { text: "" },
      publicError: toAgentPublicError(context.error, "http"),
      run: context.run,
      toolResults: context.event.toolResults,
    })
  })
  effect.active = context => options.errorFallbackText !== null
    && context.error !== undefined
    && Boolean((context as unknown as AgentRuntimeContext & { [agentWorkflowExecutionContextKey]?: boolean })[agentWorkflowExecutionContextKey])
    && (Boolean(getAgentChatContext(context.context)) || context.context.has("channel"))
  effect.kind = "chat.error-fallback"
  return effect
}

export interface AgentChatRunContext<
  TMessageMetadata extends object = Record<string, unknown>,
  TUser extends object = Record<string, unknown>,
  TMeta extends object = Record<string, unknown>,
> {
  chat?: {
    message?: Omit<AgentChatAgentHookArgs["message"], "metadata"> & { metadata?: TMessageMetadata }
    meta?: TMeta
    session?: AgentChatMessageTriggerInput["session"]
    user?: TUser
  }
}

export type AgentChatContext<
  TMeta extends object = Record<string, unknown>,
  TUser extends object = Record<string, unknown>,
  TMessageMetadata extends object = Record<string, unknown>,
> = NonNullable<AgentChatRunContext<TMessageMetadata, TUser, TMeta>["chat"]>

export type AgentChannelContext<
  TMeta extends object = Record<string, unknown>,
  TUser extends object = Record<string, unknown>,
  TMessageMetadata extends object = Record<string, unknown>,
> = AgentChatContext<TMeta, TUser, TMessageMetadata> & { run?: AgentRunMetadata }

declare global {
  interface ViteHubAgentChannelMeta {}
  interface ViteHubAgentChannelUser {}
  interface ViteHubAgentInvocationContextValues {
    channel: AgentChannelContext<ViteHubAgentChannelMeta, ViteHubAgentChannelUser>
  }
  interface ViteHubWorkspaceSourceResolutionContextMap {
    channel: AgentChannelContext<ViteHubAgentChannelMeta, ViteHubAgentChannelUser>
  }
}

export function getAgentChatContext<
  TMeta extends object = Record<string, unknown>,
  TUser extends object = Record<string, unknown>,
  TMessageMetadata extends object = Record<string, unknown>,
>(
  input: AgentInvocationContextStore | { context: AgentInvocationContextStore },
): AgentChatContext<TMeta, TUser, TMessageMetadata> | undefined {
  const store = "get" in input ? input : input.context
  return store.get<AgentChatContext<TMeta, TUser, TMessageMetadata>>(agentChatContextKey)
}

async function resolveChatThinkingFallback<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig>,
  args: AgentChatAgentHookArgs<TRuntimeConfig>,
): Promise<string | null | undefined> {
  const fallback = options.fallbackStreamingPlaceholderText
  if (fallback === null) return null
  if (typeof fallback === "function") {
    const resolved = await fallback(args)
    if (resolved === null) return null
    return typeof resolved === "string" ? resolved : undefined
  }
  if (Array.isArray(fallback)) {
    if (fallback.length === 0) return null
    return fallback[Math.floor(Math.random() * fallback.length)]
  }
  if (typeof fallback === "string") return fallback
  return undefined
}

function isResolvableObject(value: unknown): value is { resolve: (...args: never[]) => unknown } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function isStaticPlatformMap(value: AgentChatOptions["platforms"]): value is Record<string, AgentChatPlatformResolver> {
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
  input: false | AgentChannelWebhookRegistrationDefinition | AgentChannelWebhookRegistrationDefinition[],
): AgentWebhookRegistrationDefinition[] {
  if (input === false) return []
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
  if (!isStaticPlatformMap(options.platforms)) return []
  return Object.keys(options.platforms)
    .filter(platform => !hasExplicitChatWebhook(options, platform))
    .flatMap(platform => normalizeChatWebhookRegistrations(platform, {}))
}

function explicitChatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] {
  return Object.entries(options.webhooks ?? {})
    .flatMap(([platform, input]) => normalizeChatWebhookRegistrations(platform, input))
}

export function resolveChatWebhookRegistrations(options: AgentChatOptions): AgentWebhookRegistrationDefinition[] | undefined {
  const registrations = [...explicitChatWebhookRegistrations(options), ...inferredChatWebhookRegistrations(options)]
  return registrations.length ? registrations : undefined
}

function createChatMessageTrigger<TRuntimeConfig extends AgentRuntimeConfig>(
  options: AgentChatOptions<TRuntimeConfig> = {},
): AgentTriggerDefinition<TRuntimeConfig, WorkspaceName, AgentChatMessageTriggerInput> {
  return {
    input: "ui-message[]",
    output: "ui-message-stream",
    webhooks: resolveChatWebhookRegistrations(options),
    async invoke(_context, triggerInput) {
      const { hookArgs, input } = createChatMessageTriggerInput(options, triggerInput)
      const thinkingFallback = await resolveChatThinkingFallback(options, hookArgs)
      return {
        input,
        ...(thinkingFallback !== undefined ? { metadata: { thinkingFallback } } : {}),
        run: triggerInput.run,
      }
    },
  }
}

function assertNoLegacyChatHistoryOption(options: AgentChatOptions): void {
  if (Object.prototype.hasOwnProperty.call(options, "history")) {
    throw new TypeError("[vitehub] messages.history was replaced by messages.triggerHistory. Use triggerHistory to configure the chat.message trigger input window.")
  }
}

export function assertChatDeliveryOptions(options: AgentChatOptions): void {
  if (options.delivery === "manual" && (options.stream === true || options.commentary !== undefined)) {
    throw new TypeError("[vitehub] messages.delivery \"manual\" cannot be combined with messages.stream or messages.commentary.")
  }
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
    throw new TypeError("[vitehub] messages.timeout must be a positive finite number.")
  }
  if (options.durable && options.delivery !== "manual") {
    throw new TypeError("[vitehub] messages.durable requires delivery: \"manual\" so Agent finish effects own the deferred reply.")
  }
  if (options.durable && options.concurrency !== undefined && options.concurrency !== "parallel") {
    throw new TypeError(`[vitehub] messages.durable cannot be combined with concurrency: ${JSON.stringify(options.concurrency)} because Workflow handoff releases the webhook lease before the Agent Invocation settles.`)
  }
}

export function getChatCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  capabilities: AgentCapabilityDefinition[],
): AgentChatOptions<TRuntimeConfig> | undefined {
  return capabilities.find(capability => capability.id === "chat" && (capability.metadata as ChatCapabilityMetadata | undefined)?.kind === "chat")
    ?.metadata?.chat as AgentChatOptions<TRuntimeConfig> | undefined
}

export function defineChatCapability<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  const TOptions extends AgentChatOptions<TRuntimeConfig> = AgentChatOptions<TRuntimeConfig>,
>(
  options: TOptions = {} as TOptions,
): AgentCapabilityDefinition<TRuntimeConfig, WorkspaceName, ChatCapabilityTypeContract<AgentChatOptionsOrigin<TOptions>>> {
  assertNoLegacyChatHistoryOption(options)
  assertChatDeliveryOptions(options)
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
      context.delivery.finishEffect(durableChatErrorFallback(options) as never)
    },
    triggers: {
      message: createChatMessageTrigger(options),
    },
  })
}

export function chat<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  const TOptions extends AgentChatCapabilityOptions<TRuntimeConfig> = AgentChatCapabilityOptions<TRuntimeConfig>,
>(
  options: TOptions = {} as TOptions,
): AgentCapabilityDefinition<TRuntimeConfig, WorkspaceName, ChatCapabilityTypeContract<string>> {
  if (Object.prototype.hasOwnProperty.call(options, "platforms")) {
    throw new TypeError("[vitehub] chat({ platforms }) was removed. Use defineAgent({ channels }) with an adapter-backed Channel instead.")
  }
  if (Object.prototype.hasOwnProperty.call(options, "webhooks")) {
    throw new TypeError("[vitehub] chat({ webhooks }) was removed. Use defineAgent({ channels }) with an adapter-backed Channel instead.")
  }
  return defineChatCapability(options as AgentChatOptions<TRuntimeConfig>) as AgentCapabilityDefinition<TRuntimeConfig, WorkspaceName, ChatCapabilityTypeContract<string>>
}
