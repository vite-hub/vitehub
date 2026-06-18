import type {
  AgentChannelDefinition,
  AgentChatWebhookRegistrationDefinition,
  AgentMessageChannelSettings,
  AgentRuntimeConfig,
} from "./types.ts"
import type { AgentChatFetchHandlerOptions } from "./server.ts"

export type {
  AgentChannelDefinition,
  AgentChannels,
  AgentMessageChannelSettings,
} from "./types.ts"

export interface AgentChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapter?: AgentChannelDefinition<TRuntimeConfig>["adapter"]
  identity?: AgentChannelDefinition<TRuntimeConfig>["identity"]
  messages?: false | AgentMessageChannelSettings<TRuntimeConfig>
  triggers?: AgentChannelDefinition<TRuntimeConfig>["triggers"]
  webhooks?: AgentChannelDefinition<TRuntimeConfig>["webhooks"]
  [key: string]: unknown
}

export interface AgentStreamChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentChannelOptions<TRuntimeConfig> {
  route?: true | AgentChatFetchHandlerOptions
}

function githubWebhookDefaults<TRuntimeConfig extends AgentRuntimeConfig>(
  webhooks: AgentChannelDefinition<TRuntimeConfig>["webhooks"],
): AgentChannelDefinition<TRuntimeConfig>["webhooks"] {
  const defaults = {
    secretHeader: "x-hub-signature-256",
    signature: "github-sha256" as const,
  }
  if (webhooks === undefined || webhooks === true) return defaults
  if (webhooks === false) return false
  const apply = (webhook: AgentChatWebhookRegistrationDefinition<TRuntimeConfig>) => ({ ...defaults, ...webhook })
  return Array.isArray(webhooks) ? webhooks.map(apply) : apply(webhooks)
}

export function defineChannel<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  kind: string,
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  if (typeof kind !== "string" || !kind.trim()) {
    throw new TypeError("[vitehub] defineChannel() requires a non-empty Channel kind.")
  }
  const messages: false | AgentMessageChannelSettings<TRuntimeConfig> =
    options.messages === undefined ? {} as AgentMessageChannelSettings<TRuntimeConfig> : options.messages
  return {
    ...options,
    kind,
    messages,
  }
}

export function discord<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("discord", options)
}

export function github<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("github", {
    ...options,
    messages: false,
    webhooks: githubWebhookDefaults(options.webhooks),
  })
}

export function http<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  if ("path" in options) {
    throw new TypeError("[vitehub] http({ path }) is not wired yet. Use webhooks.path for webhook routes.")
  }
  return defineChannel("http", options)
}

export function slack<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("slack", options)
}

export function teams<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("teams", options)
}

export function stream<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentStreamChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("stream", {
    ...options,
    route: options.route ?? true,
  })
}

export function telegram<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("telegram", options)
}

export function webChat<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("web-chat", options)
}
