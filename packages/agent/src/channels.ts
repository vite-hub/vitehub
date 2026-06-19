import type {
  AgentChannelDefinition,
  AgentChannelDeliveryEffectContext,
  AgentChannelDeliveryEffects,
  AgentChatWebhookRegistrationDefinition,
  AgentMessageChannelSettings,
  AgentRuntimeConfig,
  MaybeResolvable,
} from "./types.ts"
import type { AgentChatFetchHandlerOptions } from "./server.ts"
import type { GitHubPullRequestCommand } from "./capabilities/input-commands.ts"

export type {
  AgentChannelDeliveryEffectContext,
  AgentChannelDeliveryEffectHandler,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryEffectKind,
  AgentChannelDeliveryEffects,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDefinition,
  AgentChannels,
  AgentMessageChannelSettings,
} from "./types.ts"

export interface AgentChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapter?: AgentChannelDefinition<TRuntimeConfig>["adapter"]
  dev?: AgentChannelDefinition<TRuntimeConfig>["dev"]
  effects?: AgentChannelDefinition<TRuntimeConfig>["effects"]
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

export interface GitHubPullRequestEffectsOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  apiBaseUrl?: string
  fetch?: typeof fetch
  statusContext?: string
  token: MaybeResolvable<string, AgentChannelDeliveryEffectContext<TRuntimeConfig>>
  userAgent?: string
}

type GitHubPullRequestStatusPayload = {
  context?: unknown
  description?: unknown
  sha?: unknown
  state?: unknown
  target_url?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function maybeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function githubCommandFromUnknown(value: unknown): GitHubPullRequestCommand | undefined {
  if (!isRecord(value)) return
  const owner = maybeString(value.owner)
  const repo = maybeString(value.repo)
  const repository = maybeString(value.repository) || (owner && repo ? `${owner}/${repo}` : undefined)
  const issueNumber = maybeNumber(value.issueNumber)
  const commentId = maybeNumber(value.commentId)
  const pullRequestUrl = maybeString(value.pullRequestUrl)
  if (!owner || !repo || !repository || !issueNumber || !commentId || !pullRequestUrl) return
  return {
    action: "created",
    actor: isRecord(value.actor) && maybeString(value.actor.login)
      ? {
          ...(maybeString(value.actor.association) ? { association: maybeString(value.actor.association) } : {}),
          ...(maybeNumber(value.actor.id) ? { id: maybeNumber(value.actor.id) } : {}),
          login: maybeString(value.actor.login)!,
          ...(maybeString(value.actor.type) ? { type: maybeString(value.actor.type) } : {}),
        }
      : { login: "" },
    args: maybeString(value.args) || "",
    command: maybeString(value.command) || "",
    commentId,
    ...(maybeString(value.commentNodeId) ? { commentNodeId: maybeString(value.commentNodeId) } : {}),
    ...(maybeString(value.deliveryId) ? { deliveryId: maybeString(value.deliveryId) } : {}),
    ...(maybeNumber(value.installationId) ? { installationId: maybeNumber(value.installationId) } : {}),
    issueNumber,
    owner,
    pullRequestUrl,
    repo,
    repository,
  }
}

function githubCommandFromEffect<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): GitHubPullRequestCommand | undefined {
  const effectPayload = isRecord(context.effect.payload) ? context.effect.payload : undefined
  const effectMetadata = context.effect.metadata
  return githubCommandFromUnknown(effectPayload?.github)
    || githubCommandFromUnknown(effectMetadata?.github)
    || githubCommandFromUnknown(isRecord(context.input.context) ? context.input.context.github : undefined)
}

async function resolveEffectOption<T, TRuntimeConfig extends AgentRuntimeConfig>(
  value: MaybeResolvable<T, AgentChannelDeliveryEffectContext<TRuntimeConfig>>,
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): Promise<T> {
  if (typeof value === "function") return await (value as (context: AgentChannelDeliveryEffectContext<TRuntimeConfig>) => T | Promise<T>)(context)
  if (isRecord(value) && typeof value.resolve === "function") return await (value.resolve as (context: AgentChannelDeliveryEffectContext<TRuntimeConfig>) => T | Promise<T>)(context)
  return value as T
}

function githubApiHeaders(token: string, userAgent?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(userAgent ? { "user-agent": userAgent } : {}),
    "x-github-api-version": "2022-11-28",
  }
}

async function githubApi(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const response = await fetcher(url, init)
  if (!response.ok) {
    throw new Error(`[vitehub] GitHub delivery effect failed with ${response.status}.`)
  }
  return response
}

function reactionContent<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string {
  if (typeof context.effect.payload === "string") return context.effect.payload
  if (isRecord(context.effect.payload) && typeof context.effect.payload.content === "string") return context.effect.payload.content
  if (context.effect.intent === "completed") return "hooray"
  if (context.effect.intent === "failed") return "confused"
  return "eyes"
}

function replyBody<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string | undefined {
  if (typeof context.effect.payload === "string") return context.effect.payload
  if (isRecord(context.effect.payload) && typeof context.effect.payload.body === "string") return context.effect.payload.body
  if (typeof context.effect.metadata?.body === "string") return context.effect.metadata.body
}

function statusPayload<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  defaultContext: string,
): GitHubPullRequestStatusPayload {
  const payload = isRecord(context.effect.payload) ? context.effect.payload : {}
  return {
    context: payload.context || context.effect.metadata?.context || defaultContext,
    description: payload.description || context.effect.metadata?.description,
    sha: payload.sha || context.effect.metadata?.sha,
    state: payload.state || context.effect.metadata?.state || (context.effect.intent === "failed" ? "failure" : context.effect.intent === "completed" ? "success" : "pending"),
    target_url: payload.target_url || context.effect.metadata?.target_url,
  }
}

async function githubPullRequestHeadSha(
  fetcher: typeof fetch,
  command: GitHubPullRequestCommand,
  headers: Record<string, string>,
): Promise<string | undefined> {
  const response = await githubApi(fetcher, command.pullRequestUrl, { headers, method: "GET" })
  const payload = await response.json().catch(() => undefined)
  return isRecord(payload) && isRecord(payload.head) ? maybeString(payload.head.sha) : undefined
}

export function githubPullRequestEffects<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: GitHubPullRequestEffectsOptions<TRuntimeConfig>,
): AgentChannelDeliveryEffects<TRuntimeConfig> {
  return {
    async reaction(context) {
      const command = githubCommandFromEffect(context)
      if (!command) return
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/issues/comments/${command.commentId}/reactions`
      await githubApi(fetcher, url, {
        body: JSON.stringify({ content: reactionContent(context) }),
        headers: githubApiHeaders(token, options.userAgent),
        method: "POST",
      })
    },
    async reply(context) {
      const command = githubCommandFromEffect(context)
      const body = replyBody(context)
      if (!command || !body) return
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/issues/${command.issueNumber}/comments`
      await githubApi(fetcher, url, {
        body: JSON.stringify({ body }),
        headers: githubApiHeaders(token, options.userAgent),
        method: "POST",
      })
    },
    async status(context) {
      const command = githubCommandFromEffect(context)
      if (!command) return
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const headers = githubApiHeaders(token, options.userAgent)
      const payload = statusPayload(context, options.statusContext || "ViteHub Agent")
      const sha = maybeString(payload.sha) || await githubPullRequestHeadSha(fetcher, command, headers)
      if (!sha) return
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/statuses/${sha}`
      await githubApi(fetcher, url, {
        body: JSON.stringify({ ...payload, sha: undefined }),
        headers,
        method: "POST",
      })
    },
  }
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

function telegramWebhookDefaults<TRuntimeConfig extends AgentRuntimeConfig>(
  webhooks: AgentChannelDefinition<TRuntimeConfig>["webhooks"],
): AgentChannelDefinition<TRuntimeConfig>["webhooks"] {
  const defaults = { secretHeader: "x-telegram-bot-api-secret-token" }
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
  return defineChannel("telegram", {
    ...options,
    webhooks: telegramWebhookDefaults(options.webhooks),
  })
}

export function webChat<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("web-chat", options)
}
