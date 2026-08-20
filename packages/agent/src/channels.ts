import { createHash, createSign } from "node:crypto"
import { CHAT_FINISH_EXTENSION_CONTEXT_KEY } from "./chat-trigger.ts"
import { readPullRequestContext } from "./capabilities/repository-host-context.ts"
import { defineCapability } from "./capability-runtime.ts"
import { isAsyncIterable } from "./internal/stream-result.ts"
import { clearMessageChannelProgress, messageChannelProgressClearedContextKey, messageChannelProgressContextKey, type MessageChannelProgressReference } from "./internal/message-channel-progress.ts"
import {
  deliveryArtifactAttachments,
  deliveryArtifactMarkdownReferencePaths,
  normalizeDeliveryArtifactPath,
  publishedDeliveryArtifactsFromUnknown,
  publishWorkspaceArtifacts,
  rewriteDeliveryArtifactMarkdown,
} from "./delivery-artifacts.ts"
import type {
  AgentDeliveryArtifactPublishInput,
  AgentDeliveryArtifactPublishResult,
} from "./delivery-artifacts.ts"

import type {
  AgentCallbackContext,
  AgentCapabilityDefinition,
  AgentChatFinishExtension,
  AgentChatMessage,
  AgentChatPlatformAdapter,
  AgentChannelDefinition,
  AgentChannelTriggerContext,
  AgentChannelDeliveryEffectContext,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryEffects,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDeliveryFinishEffectContext,
  AgentChannelDeliveryReplyStream,
  AgentChannelWebhookRegistrationDefinition,
  AgentFinishEvent,
  AgentRunInput,
  AgentTriggerDefinition,
  AgentMessageChannelSettings,
  AgentTriggerInvokeResult,
  AgentRuntimeConfig,
  AgentWebhookSecretToken,
  MaybePromise,
  MaybeResolvable,
  PublishedAgentDeliveryArtifact,
} from "./types.ts"
import { defineMessageChannelInstructions } from "./internal/channels.ts"
import { withAgentChannelSyncDefinition } from "./internal/channel-sync.ts"
import { withAgentChannelHistoryDefinition } from "./internal/channel-history.ts"
import { createTelegramChannelSyncProvider } from "./internal/telegram-channel-sync.ts"
import type { PullRequestContextValue } from "./capabilities/repository-host-context.ts"
import type { AgentChannelChatRouteBody, AgentChannelChatRouteHandlerOptions } from "./server.ts"
import type { TelegramAdapterConfig } from "@chat-adapter/telegram"
import { resolveRuntimeValue } from "@vite-hub/runtime"
import type { Adapter, FileUpload } from "chat"

export const messageChannelTitleSupportContextKey = "channel.delivery.supportsTitle"
const customTitleEffectChannels = new WeakSet<object>()

export {
  deliveryArtifactAttachments,
  publishWorkspaceArtifacts,
  rewriteDeliveryArtifactMarkdown,
} from "./delivery-artifacts.ts"
export type {
  AgentDeliveryArtifactPublisher,
  AgentDeliveryArtifactPublishInput,
  AgentDeliveryArtifactPublishResult,
  PublishWorkspaceArtifactsOptions,
} from "./delivery-artifacts.ts"
export { defineFinishEffect } from "./delivery-effects.ts"
export type {
  AgentChannelDeliveryEffectContext,
  AgentChannelDeliveryEffectHandler,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryEffectIntentOptions,
  AgentChannelDeliveryEffectPayload,
  AgentChannelDeliveryEffectKind,
  AgentChannelDeliveryEffects,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDeliveryFinishEffectCallback,
  AgentChannelDeliveryFinishEffectResult,
  AgentChannelDeliveryFinishEffectContext,
  AgentChannelDeliveryReactionInput,
  AgentChannelDeliveryReactionPayload,
  AgentChannelDeliveryReplyInput,
  AgentChannelDeliveryReplyPayload,
  AgentChannelDeliveryReplyStream,
  AgentChannelDeliveryStatusInput,
  AgentChannelDeliveryStatusPayload,
  AgentChannelDeliveryStatusState,
  AgentChannelDefinition,
  AgentChannelFactory,
  AgentChannelInput,
  AgentChannelInputs,
  AgentChannels,
  AgentDeliveryArtifact,
  AgentDeliveryArtifactPlacement,
  AgentMessageChannelSettings,
  PublishedAgentDeliveryArtifact,
} from "./types.ts"
export interface AgentChannelOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody,
  TAuth = unknown,
> {
  adapter?: AgentChannelDefinition<TRuntimeConfig>["adapter"]
  capabilities?: AgentChannelDefinition<TRuntimeConfig>["capabilities"]
  effects?: AgentChannelDefinition<TRuntimeConfig>["effects"]
  identity?: AgentChannelDefinition<TRuntimeConfig>["identity"]
  messages?: false | AgentMessageChannelSettings<TRuntimeConfig>
  route?: boolean | AgentChannelChatRouteHandlerOptions<TBody, TAuth>
  triggers?: AgentChannelDefinition<TRuntimeConfig>["triggers"]
  webhooks?: AgentChannelDefinition<TRuntimeConfig>["webhooks"]
}

type AgentChannelDefinitionOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Omit<AgentChannelDefinition<TRuntimeConfig>, "kind">

export interface AgentWebChatChannelOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody,
  TAuth = unknown,
> extends AgentChannelOptions<TRuntimeConfig, TBody, TAuth> {}

type GitHubAppValue<T, TRuntimeConfig extends AgentRuntimeConfig> =
  MaybeResolvable<T, AgentCallbackContext<TRuntimeConfig> | AgentChannelDeliveryEffectContext<TRuntimeConfig>>
type GitHubAppContext<TRuntimeConfig extends AgentRuntimeConfig> =
  AgentCallbackContext<TRuntimeConfig> | AgentChannelDeliveryEffectContext<TRuntimeConfig>

export interface GitHubAppOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  apiBaseUrl?: string
  appId?: GitHubAppValue<number | string | undefined, TRuntimeConfig>
  artifacts?: false | {
    branch?: string
    pathPrefix?: string
  }
  fetch?: typeof fetch
  installationId?: GitHubAppValue<number | string | undefined, TRuntimeConfig>
  privateKey?: GitHubAppValue<string | { unseal: () => string } | undefined, TRuntimeConfig>
  privateKeyPath?: GitHubAppValue<string | undefined, TRuntimeConfig>
  statusContext?: string
  userAgent?: string
  webhookSecret?: GitHubAppValue<false | string | { unseal: () => string } | undefined, TRuntimeConfig>
}

export type GitHubIssueCommentPayload = {
  action?: unknown
  comment?: {
    author_association?: unknown
    body?: unknown
    created_at?: unknown
    html_url?: unknown
    id?: unknown
    node_id?: unknown
    updated_at?: unknown
    user?: { id?: unknown, login?: unknown, type?: unknown }
  }
  installation?: { id?: unknown }
  issue?: {
    author_association?: unknown
    body?: unknown
    html_url?: unknown
    labels?: unknown
    number?: unknown
    pull_request?: { html_url?: unknown, url?: unknown }
    title?: unknown
  }
  repository?: {
    full_name?: unknown
    name?: unknown
    owner?: { login?: unknown }
  }
  sender?: { id?: unknown, login?: unknown, type?: unknown }
}

export interface GitHubPullRequestCommand {
  action: "created"
  actor: {
    association?: string
    id?: number
    login: string
    type?: string
  }
  args: string
  body: string
  command: `/${string}` | (string & {})
  commentId: number
  commentNodeId?: string
  deliveryId?: string
  installationId?: number
  issueNumber: number
  owner: string
  pullRequestUrl: string
  repo: string
  repository: string
}

export interface GitHubPullRequestFileMetadata {
  additions?: number
  blobUrl?: string
  changes?: number
  contentsUrl?: string
  deletions?: number
  filename: string
  previousFilename?: string
  rawUrl?: string
  status?: string
}

export interface GitHubPullRequestCommentMetadata {
  authorAssociation?: string
  body?: string
  createdAt?: string
  htmlUrl?: string
  id: number
  nodeId?: string
  updatedAt?: string
  user?: {
    id?: number
    login?: string
    type?: string
  }
}

export interface GitHubPullRequestRefMetadata {
  ref?: string
  repo?: string
  sha?: string
}

export interface GitHubPullRequestMetadata {
  omittedComments?: number
  omittedFiles?: number
  unavailable?: string
}

export interface GitHubPullRequestRunContext {
  pullRequest: {
    apiUrl: string
    base?: GitHubPullRequestRefMetadata
    body?: string
    comments?: GitHubPullRequestCommentMetadata[]
    files?: GitHubPullRequestFileMetadata[]
    head?: GitHubPullRequestRefMetadata
    htmlUrl?: string
    labels?: string[]
    metadata?: GitHubPullRequestMetadata
    number: number
    source: {
      checkout?: boolean
      mount: string
      ref: string
      repo: string
    }
    title?: string
  }
  repository: {
    fullName: string
    name: string
    owner: string
  }
  run: {
    messageId: string
    origin: string
    runId: string
    threadId: string
  }
  trigger: {
    action: GitHubPullRequestCommand["action"]
    actor: GitHubPullRequestCommand["actor"]
    args: string
    command: string
    comment: {
      authorAssociation?: string
      body?: string
      createdAt?: string
      htmlUrl?: string
      id: number
      nodeId?: string
      updatedAt?: string
    }
    deliveryId?: string
    event: "issue_comment"
    installationId?: number
    sender?: {
      id?: number
      login?: string
      type?: string
    }
  }
}

export interface GitHubPullRequestReadInvocation {
  context: {
    get: (key: string) => unknown
  }
}

declare global {
  interface ViteHubWorkspaceSourceResolutionContextMap {
    github: GitHubPullRequestCommand
    pullRequest: GitHubPullRequestRunContext
  }
  interface ViteHubAgentInvocationContextValues {
    github: GitHubPullRequestCommand
    pullRequest: GitHubPullRequestRunContext
  }
}

function githubPullRequestRunContextFromUnknown(input: unknown): GitHubPullRequestRunContext | undefined {
  if (!isRecord(input)) return
  const value = isRecord(input.pullRequest) && isRecord(input.pullRequest.pullRequest) ? input.pullRequest : input
  if (!isRecord(value.pullRequest) || !isRecord(value.repository) || !isRecord(value.run) || !isRecord(value.trigger)) return
  return value as unknown as GitHubPullRequestRunContext
}

export const pullRequest = {
  read(invocation: GitHubPullRequestReadInvocation): PullRequestContextValue {
    const context = readPullRequestContext(invocation)
    if (!context) throw new Error("[vitehub] pullRequest.read() requires pull request invocation context.")
    return context
  },
}

export interface GitHubPullRequestCommentEventOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  ignored?: (reason: string) => Response
  maxBodyLength?: number
  maxCommentBodyLength?: number
  maxComments?: number
  maxFiles?: number
  origin?: string
  reply?: boolean | AgentChannelDeliveryFinishEffect
  sourceMount?: string
  threadId?: string
  workspace?: boolean | {
    mount?: string
  }
}

export interface GitHubChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentChannelOptions<TRuntimeConfig> {
  app?: true | GitHubAppOptions<TRuntimeConfig>
  pullRequest?: boolean | GitHubPullRequestCommentEventOptions<TRuntimeConfig>
}

export interface DiscordAdapterOptions {
  apiUrl?: string
  applicationId?: string
  botToken?: string | { unseal: () => string }
  longContent?: {
    mode: "split" | "truncate"
  }
  mentionRoleIds?: string[]
  publicKey?: string | { unseal: () => string }
  userName?: string
}

export interface DiscordChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends Omit<AgentChannelOptions<TRuntimeConfig>, "adapter"> {
  adapter?: true | DiscordAdapterOptions | AgentChannelOptions<TRuntimeConfig>["adapter"]
}

type TelegramChannelValue<T, TRuntimeConfig extends AgentRuntimeConfig> =
  MaybeResolvable<T, AgentCallbackContext<TRuntimeConfig>>
type TelegramSecret = string | { unseal: () => string }

export interface TelegramChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends Omit<AgentChannelOptions<TRuntimeConfig>, "adapter"> {
  adapter?: AgentChannelOptions<TRuntimeConfig>["adapter"]
  allowedUserIds?: TelegramChannelValue<TelegramAdapterConfig["allowedUserIds"], TRuntimeConfig>
  apiBaseUrl?: TelegramChannelValue<TelegramAdapterConfig["apiBaseUrl"], TRuntimeConfig>
  apiUrl?: TelegramChannelValue<TelegramAdapterConfig["apiUrl"], TRuntimeConfig>
  botToken?: TelegramChannelValue<TelegramSecret | undefined, TRuntimeConfig>
  longPolling?: TelegramChannelValue<TelegramAdapterConfig["longPolling"], TRuntimeConfig>
  mode?: TelegramAdapterConfig["mode"]
  userName?: TelegramChannelValue<TelegramAdapterConfig["userName"], TRuntimeConfig>
  webhookSecret?: TelegramChannelValue<false | TelegramSecret | undefined, TRuntimeConfig>
}

interface GitHubPullRequestEffectsOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  apiBaseUrl?: string
  artifacts?: GitHubAppOptions<TRuntimeConfig>["artifacts"]
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

interface GitHubPullRequestWorkspacePolicy {
  enabled: boolean
  mount: string
}

function normalizeGitHubPullRequestWorkspaceMount(mount: string): string {
  const normalized = mount.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  const parts = normalized.split("/").filter(Boolean)
  if (mount.startsWith("/") || /^[A-Za-z]:[\\/]/.test(mount) || parts.some(part => part === "." || part === "..") || parts[0] === ".git" || parts[0] === ".vitehub") {
    throw new TypeError("[vitehub] GitHub pull request workspace mount must stay inside the Workspace.")
  }
  return parts.join("/")
}

function githubPullRequestWorkspacePolicy(
  options: GitHubPullRequestCommentEventOptions,
): GitHubPullRequestWorkspacePolicy {
  if (options.workspace === false) {
    return {
      enabled: false,
      mount: options.sourceMount ?? "",
    }
  }
  const mount = options.workspace === true
    ? ""
    : typeof options.workspace === "object"
      ? options.workspace.mount ?? ""
      : options.sourceMount ?? "portal"
  return {
    enabled: true,
    mount: normalizeGitHubPullRequestWorkspaceMount(mount),
  }
}

function maybeStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return
  const strings = value.filter((item): item is string => typeof item === "string" && Boolean(item))
  return strings.length ? strings : undefined
}

function githubUserMetadata(value: unknown): GitHubPullRequestCommentMetadata["user"] | undefined {
  if (!isRecord(value)) return
  const login = maybeString(value.login)
  const id = maybeNumber(value.id)
  const type = maybeString(value.type)
  if (!login && !id && !type) return
  return {
    ...(id !== undefined ? { id } : {}),
    ...(login ? { login } : {}),
    ...(type ? { type } : {}),
  }
}

function githubCommentMetadata(value: unknown): GitHubPullRequestCommentMetadata | undefined {
  if (!isRecord(value)) return
  const id = maybeNumber(value.id)
  if (id === undefined) return
  const user = githubUserMetadata(value.user)
  return {
    ...(maybeString(value.author_association) ? { authorAssociation: maybeString(value.author_association) } : {}),
    ...(maybeString(value.body) ? { body: maybeString(value.body) } : {}),
    ...(maybeString(value.created_at) ? { createdAt: maybeString(value.created_at) } : {}),
    ...(maybeString(value.html_url) ? { htmlUrl: maybeString(value.html_url) } : {}),
    id,
    ...(maybeString(value.node_id) ? { nodeId: maybeString(value.node_id) } : {}),
    ...(maybeString(value.updated_at) ? { updatedAt: maybeString(value.updated_at) } : {}),
    ...(user ? { user } : {}),
  }
}

function githubFileMetadata(value: unknown): GitHubPullRequestFileMetadata | undefined {
  if (!isRecord(value)) return
  const filename = maybeString(value.filename)
  if (!filename) return
  const additions = maybeNumber(value.additions)
  const changes = maybeNumber(value.changes)
  const deletions = maybeNumber(value.deletions)
  return {
    ...(additions !== undefined ? { additions } : {}),
    ...(maybeString(value.blob_url) ? { blobUrl: maybeString(value.blob_url) } : {}),
    ...(changes !== undefined ? { changes } : {}),
    ...(maybeString(value.contents_url) ? { contentsUrl: maybeString(value.contents_url) } : {}),
    ...(deletions !== undefined ? { deletions } : {}),
    filename,
    ...(maybeString(value.previous_filename) ? { previousFilename: maybeString(value.previous_filename) } : {}),
    ...(maybeString(value.raw_url) ? { rawUrl: maybeString(value.raw_url) } : {}),
    ...(maybeString(value.status) ? { status: maybeString(value.status) } : {}),
  }
}

function githubRefMetadata(value: unknown): GitHubPullRequestRefMetadata | undefined {
  if (!isRecord(value)) return
  const ref = maybeString(value.ref)
  const repo = isRecord(value.repo) ? maybeString(value.repo.full_name) : undefined
  const sha = maybeString(value.sha)
  if (!ref && !repo && !sha) return
  return {
    ...(ref ? { ref } : {}),
    ...(repo ? { repo } : {}),
    ...(sha ? { sha } : {}),
  }
}

const defaultGitHubPullRequestMaxBodyLength = 12_000
const defaultGitHubPullRequestMaxCommentBodyLength = 2_000
const defaultGitHubPullRequestMaxComments = 30
const defaultGitHubPullRequestMaxFiles = 200

function githubPullRequestLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function truncateGitHubPullRequestText(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) return value
  return maxLength > 0
    ? `${value.slice(0, maxLength)}\n[truncated ${value.length - maxLength} characters]`
    : `[truncated ${value.length} characters]`
}

type GitHubPullRequestMetadataFields = Pick<GitHubPullRequestRunContext["pullRequest"], "base" | "body" | "comments" | "files" | "head" | "metadata">

function chatFinishExtension(input: AgentRunInput): AgentChatFinishExtension | undefined {
  const value = isRecord(input.context) ? input.context[CHAT_FINISH_EXTENSION_CONTEXT_KEY] : undefined
  return chatFinishExtensionFromUnknown(value)
}

function chatFinishExtensionFromUnknown(value: unknown): AgentChatFinishExtension | undefined {
  return isRecord(value) && typeof value.sendMessage === "function"
    ? value as unknown as AgentChatFinishExtension
    : undefined
}

function inputPayload(input: unknown): GitHubIssueCommentPayload | undefined {
  if (!isRecord(input)) return
  return isRecord(input.payload) ? input.payload as GitHubIssueCommentPayload : undefined
}

function inputPayloadOrBody(input: unknown): GitHubIssueCommentPayload | undefined {
  const payload = inputPayload(input)
  if (payload) return payload
  if (!isRecord(input) || typeof input.body !== "string") return
  return JSON.parse(input.body || "{}") as GitHubIssueCommentPayload
}

function inputGithubFacts(input: unknown): Record<string, unknown> | undefined {
  if (!isRecord(input)) return
  return isRecord(input.github) ? input.github : undefined
}

function parseSlashCommand(body: string): { args: string, command: `/${string}` | (string & {}) } | undefined {
  const text = body.trim()
  const match = /^(\/[a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(text)
  if (!match) return
  return {
    args: match[2]?.trim() || "",
    command: match[1] as `/${string}`,
  }
}

type InputCommandsMetadata = {
  commands: Record<string, { channels?: readonly string[] } | unknown>
  trigger: string
}

function inputCommandsMetadata(value: unknown): InputCommandsMetadata | undefined {
  if (!isRecord(value) || Array.isArray(value.commands) || !isRecord(value.commands) || typeof value.trigger !== "string") return
  return { commands: value.commands, trigger: value.trigger }
}

function declaredInputCommand<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelTriggerContext<TRuntimeConfig>,
  command: string,
): boolean | undefined {
  let sawMatchingTrigger = false
  const channelId = context.trigger.channelId
  for (const capability of context.agentCapabilities || []) {
    const metadata = inputCommandsMetadata(capability.metadata)
    if (!metadata || !command.startsWith(metadata.trigger)) continue
    const name = command.slice(metadata.trigger.length)
    if (!name) continue
    sawMatchingTrigger = true
    const configured = metadata.commands[name]
    if (!configured) continue
    const channels = isRecord(configured) && Array.isArray(configured.channels) ? configured.channels : undefined
    if (!channels?.length || channels.includes(channelId || "")) return true
  }
  return sawMatchingTrigger ? false : undefined
}

function githubPullRequestCommandFromInput(input: unknown): GitHubPullRequestCommand | undefined {
  const payload = inputPayload(input)
  const facts = inputGithubFacts(input)
  const event = maybeString(facts?.event)
  if (!payload || (event && event !== "issue_comment") || payload.action !== "created") return
  if (!payload.issue?.pull_request) return
  const body = maybeString(payload.comment?.body)
  const parsed = body ? parseSlashCommand(body) : undefined
  if (!body || !parsed) return
  const repository = maybeString(payload.repository?.full_name)
  const [owner, repo] = repository?.split("/") || []
  const login = maybeString(payload.comment?.user?.login)
  const issueNumber = maybeNumber(payload.issue?.number)
  const commentId = maybeNumber(payload.comment?.id)
  const pullRequestUrl = maybeString(payload.issue.pull_request.url)
  if (!repository || !owner || !repo || !login || !issueNumber || !commentId || !pullRequestUrl) return
  const association = maybeString(payload.comment?.author_association) || maybeString(payload.issue.author_association)
  const installationId = maybeNumber(facts?.installationId) ?? maybeNumber(payload.installation?.id)
  return {
    action: "created",
    actor: {
      ...(association ? { association } : {}),
      ...(maybeNumber(payload.comment?.user?.id) ? { id: maybeNumber(payload.comment?.user?.id) } : {}),
      login,
      ...(maybeString(payload.comment?.user?.type) ? { type: maybeString(payload.comment?.user?.type) } : {}),
    },
    args: parsed.args,
    body,
    command: parsed.command,
    commentId,
    ...(maybeString(payload.comment?.node_id) ? { commentNodeId: maybeString(payload.comment?.node_id) } : {}),
    ...(maybeString(facts?.deliveryId) ? { deliveryId: maybeString(facts?.deliveryId) } : {}),
    ...(installationId ? { installationId } : {}),
    issueNumber,
    owner,
    pullRequestUrl,
    repo,
    repository,
  }
}

async function githubPullRequestMetadata<TRuntimeConfig extends AgentRuntimeConfig>(
  app: true | GitHubAppOptions<TRuntimeConfig> | undefined,
  context: AgentCallbackContext<TRuntimeConfig>,
  command: GitHubPullRequestCommand,
  options: GitHubPullRequestCommentEventOptions<TRuntimeConfig>,
  payload?: GitHubIssueCommentPayload,
): Promise<GitHubPullRequestMetadataFields> {
  const maxBodyLength = githubPullRequestLimit(options.maxBodyLength, defaultGitHubPullRequestMaxBodyLength)
  const maxCommentBodyLength = githubPullRequestLimit(options.maxCommentBodyLength, defaultGitHubPullRequestMaxCommentBodyLength)
  const maxComments = githubPullRequestLimit(options.maxComments, defaultGitHubPullRequestMaxComments)
  const maxFiles = githubPullRequestLimit(options.maxFiles, defaultGitHubPullRequestMaxFiles)
  const fallbackBody = truncateGitHubPullRequestText(maybeString(payload?.issue?.body), maxBodyLength)
  const fallback = {
    ...(fallbackBody ? { body: fallbackBody } : {}),
  }

  try {
    const appOptions = app ? githubAppOptions(app) || {} : {}
    const token = await githubPullRequestMetadataToken(app, context, command.installationId).catch(() => undefined)
    const fetcher = appOptions.fetch || fetch
    const headers = githubApiHeaders(token, appOptions.userAgent)
    const apiBaseUrl = appOptions.apiBaseUrl || "https://api.github.com"
    const [pullRequest, comments, files] = await Promise.all([
      githubApiJson(fetcher, command.pullRequestUrl, headers),
      token ? githubApiJsonPages(fetcher, `${apiBaseUrl}/repos/${command.owner}/${command.repo}/issues/${command.issueNumber}/comments`, headers, maxComments + 1) : [],
      token ? githubApiJsonPages(fetcher, `${apiBaseUrl}/repos/${command.owner}/${command.repo}/pulls/${command.issueNumber}/files`, headers, maxFiles + 1) : [],
    ])
    const commentMetadata = Array.isArray(comments)
      ? comments.map(githubCommentMetadata).filter((comment): comment is GitHubPullRequestCommentMetadata => Boolean(comment))
      : []
    const fileMetadata = Array.isArray(files)
      ? files.map(githubFileMetadata).filter((file): file is GitHubPullRequestFileMetadata => Boolean(file))
      : []
    const metadata = {
      ...(commentMetadata.length > maxComments ? { omittedComments: commentMetadata.length - maxComments } : {}),
      ...(fileMetadata.length > maxFiles ? { omittedFiles: fileMetadata.length - maxFiles } : {}),
    }
    const body = isRecord(pullRequest) ? truncateGitHubPullRequestText(maybeString(pullRequest.body), maxBodyLength) : undefined
    return {
      ...fallback,
      ...(body ? { body } : {}),
      ...(isRecord(pullRequest) && githubRefMetadata(pullRequest.base) ? { base: githubRefMetadata(pullRequest.base) } : {}),
      ...(isRecord(pullRequest) && githubRefMetadata(pullRequest.head) ? { head: githubRefMetadata(pullRequest.head) } : {}),
      ...(commentMetadata.length ? { comments: commentMetadata.slice(0, maxComments).map(comment => ({
        ...comment,
        ...(comment.body ? { body: truncateGitHubPullRequestText(comment.body, maxCommentBodyLength)! } : {}),
      })) } : {}),
      ...(fileMetadata.length ? { files: fileMetadata.slice(0, maxFiles) } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    }
  }
  catch (error) {
    return {
      ...fallback,
      metadata: {
        unavailable: error instanceof Error && error.message ? error.message : "unknown",
      },
    }
  }
}

function githubPullRequestRunContext(
  command: GitHubPullRequestCommand,
  options: GitHubPullRequestCommentEventOptions = {},
  payload?: GitHubIssueCommentPayload,
  metadata: GitHubPullRequestMetadataFields = {},
): GitHubPullRequestRunContext {
  const runId = command.deliveryId || `github:${command.repository}#${command.issueNumber}:comment:${command.commentId}`
  const workspace = githubPullRequestWorkspacePolicy(options)
  const labels = maybeStrings(Array.isArray(payload?.issue?.labels)
    ? payload.issue.labels.map(label => isRecord(label) ? maybeString(label.name) : undefined)
    : undefined)
  return {
    pullRequest: {
      apiUrl: command.pullRequestUrl,
      ...metadata,
      ...(maybeString(payload?.issue?.pull_request?.html_url) || maybeString(payload?.issue?.html_url)
        ? { htmlUrl: maybeString(payload?.issue?.pull_request?.html_url) || maybeString(payload?.issue?.html_url) }
        : {}),
      ...(labels ? { labels } : {}),
      number: command.issueNumber,
      source: {
        ...(!workspace.enabled ? { checkout: false } : {}),
        mount: workspace.enabled ? workspace.mount : options.sourceMount ?? command.repo,
        ref: `refs/pull/${command.issueNumber}/head`,
        repo: command.repository,
      },
      ...(maybeString(payload?.issue?.title) ? { title: maybeString(payload?.issue?.title) } : {}),
    },
    repository: {
      fullName: command.repository,
      name: command.repo,
      owner: command.owner,
    },
    run: {
      messageId: String(command.commentId),
      origin: options.origin || "github-pull-request-comment",
      runId,
      threadId: options.threadId || command.pullRequestUrl,
    },
    trigger: {
      action: command.action,
      actor: command.actor,
      args: command.args,
      command: command.command,
      comment: {
        ...(command.actor.association ? { authorAssociation: command.actor.association } : {}),
        ...(maybeString(payload?.comment?.body) ? { body: maybeString(payload?.comment?.body) } : {}),
        ...(maybeString(payload?.comment?.created_at) ? { createdAt: maybeString(payload?.comment?.created_at) } : {}),
        ...(maybeString(payload?.comment?.html_url) ? { htmlUrl: maybeString(payload?.comment?.html_url) } : {}),
        id: command.commentId,
        ...(command.commentNodeId ? { nodeId: command.commentNodeId } : {}),
        ...(maybeString(payload?.comment?.updated_at) ? { updatedAt: maybeString(payload?.comment?.updated_at) } : {}),
      },
      ...(command.deliveryId ? { deliveryId: command.deliveryId } : {}),
      event: "issue_comment",
      ...(command.installationId ? { installationId: command.installationId } : {}),
      ...(payload?.sender
        ? {
            sender: {
              ...(maybeNumber(payload.sender.id) ? { id: maybeNumber(payload.sender.id) } : {}),
              ...(maybeString(payload.sender.login) ? { login: maybeString(payload.sender.login) } : {}),
              ...(maybeString(payload.sender.type) ? { type: maybeString(payload.sender.type) } : {}),
            },
          }
        : {}),
    },
  }
}

function pullRequestCommandInput(
  command: GitHubPullRequestCommand,
  pullRequest: GitHubPullRequestRunContext,
): AgentRunInput {
  return {
    context: {
      github: command,
      pullRequest,
    },
    prompt: command.body,
  }
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
    body: maybeString(value.body) || maybeString(value.command) || "",
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

async function resolveGithubAppOption<T, TRuntimeConfig extends AgentRuntimeConfig>(
  value: GitHubAppValue<T, TRuntimeConfig> | undefined,
  context: GitHubAppContext<TRuntimeConfig>,
): Promise<T | undefined> {
  if (value === undefined) return undefined
  if (typeof value === "function") return await (value as (context: GitHubAppContext<TRuntimeConfig>) => T | Promise<T>)(context)
  if (isRecord(value) && typeof value.resolve === "function") return await (value.resolve as (context: GitHubAppContext<TRuntimeConfig>) => T | Promise<T>)(context)
  return value as T
}

function unseal(value: unknown): unknown {
  return isRecord(value) && typeof value.unseal === "function" ? value.unseal() : value
}

function cleanSecret(value: unknown): string | undefined {
  const secret = unseal(value)
  return typeof secret === "string" && secret.trim() ? secret.trim() : undefined
}

function runtimeEnv<TRuntimeConfig extends AgentRuntimeConfig>(
  name: string,
  context: AgentCallbackContext<TRuntimeConfig>,
): unknown {
  return context.cloudflare?.env?.[name]
    ?? (typeof process === "object" && process?.env ? process.env[name] : undefined)
}

const serverEnvModuleId = "#vitehub/env/server"

async function githubEnv(event?: unknown): Promise<Record<string, unknown>> {
  const fallback = typeof process === "object" && process?.env
    ? {
        appId: process.env.GITHUB_APP_ID,
        appInstallationId: process.env.GITHUB_APP_INSTALLATION_ID,
        appPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
        appPrivateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
        token: process.env.VITEHUB_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
        webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      }
    : {}
  try {
    // hubEnv() rewrites the tagged import so Vite can resolve its generated module.
    const module = await import(/* @vite-ignore */ /* @vitehub-env */ serverEnvModuleId) as { useServerEnv?: (event?: unknown) => unknown }
    const env = module.useServerEnv?.(event)
    const github = isRecord(env) && isRecord(env.github)
      ? Object.fromEntries(Object.entries(env.github).filter(([, value]) => value !== undefined))
      : {}
    return {
      ...fallback,
      ...github,
    }
  }
  catch {
    return fallback
  }
}

function githubAppOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  app: true | GitHubAppOptions<TRuntimeConfig> | undefined,
): GitHubAppOptions<TRuntimeConfig> | undefined {
  return app === true ? {} : app
}

async function githubAppSetting<T, TRuntimeConfig extends AgentRuntimeConfig>(
  options: GitHubAppOptions<TRuntimeConfig>,
  env: Record<string, unknown>,
  key: keyof GitHubAppOptions<TRuntimeConfig>,
  envKey: string,
  context: AgentCallbackContext<TRuntimeConfig> | AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): Promise<T | undefined> {
  return await resolveGithubAppOption(options[key] as GitHubAppValue<T, TRuntimeConfig> | undefined, context) ?? unseal(env[envKey]) as T | undefined
}

function requiredString(value: unknown, name: string): string {
  const string = typeof value === "number" ? String(value) : cleanSecret(value)
  if (!string) throw new Error(`[vitehub] Missing GitHub App ${name}.`)
  return string
}

function requiredNumber(value: unknown, name: string): number {
  const number = typeof value === "number" ? value : Number(cleanSecret(value))
  if (!Number.isFinite(number)) throw new Error(`[vitehub] Missing GitHub App ${name}.`)
  return number
}

async function githubAppPrivateKey<TRuntimeConfig extends AgentRuntimeConfig>(
  options: GitHubAppOptions<TRuntimeConfig>,
  env: Record<string, unknown>,
  context: AgentCallbackContext<TRuntimeConfig> | AgentChannelDeliveryEffectContext<TRuntimeConfig>,
) {
  const inline = cleanSecret(await githubAppSetting(options, env, "privateKey", "appPrivateKey", context))
  if (inline) return inline.replace(/\\n/g, "\n")
  const path = cleanSecret(await githubAppSetting(options, env, "privateKeyPath", "appPrivateKeyPath", context))
  if (path) {
    try {
      const { readFileSync } = await import(/* @vite-ignore */ "node:fs")
      const file = readFileSync(path, "utf8").trim()
      if (file) return file.replace(/\\n/g, "\n")
    }
    catch (error) {
      throw new Error(`[vitehub] Failed to read GitHub App privateKeyPath: ${path}`, { cause: error })
    }
  }
  throw new Error("[vitehub] Missing GitHub App privateKey. github.app.privateKey, github.app.privateKeyPath, GITHUB_APP_PRIVATE_KEY, or GITHUB_APP_PRIVATE_KEY_PATH is required.")
}

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url")
}

function githubAppJwt(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64url(JSON.stringify({ exp: now + 540, iat: now - 60, iss: appId }))
  const data = `${header}.${payload}`
  return `${data}.${createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url")}`
}

const githubAppTokenCache = new Map<string, { expiresAt: number, token: string }>()

async function githubAppInstallationToken<TRuntimeConfig extends AgentRuntimeConfig>(
  app: true | GitHubAppOptions<TRuntimeConfig>,
  context: GitHubAppContext<TRuntimeConfig>,
  installation?: number,
) {
  const options = githubAppOptions(app) || {}
  const env = await githubEnv(context)
  const appId = requiredString(await githubAppSetting(options, env, "appId", "appId", context), "appId")
  const installationId = installation
    ?? ("effect" in context ? githubCommandFromEffect(context as AgentChannelDeliveryEffectContext<TRuntimeConfig>)?.installationId : undefined)
    ?? requiredNumber(await githubAppSetting(options, env, "installationId", "appInstallationId", context), "installationId")
  const apiBaseUrl = options.apiBaseUrl || "https://api.github.com"
  const cacheKey = `${apiBaseUrl}:${appId}:${installationId}`
  const cached = githubAppTokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const response = await githubApi(options.fetch || fetch, `${apiBaseUrl}/app/installations/${installationId}/access_tokens`, {
    headers: githubApiHeaders(githubAppJwt(appId, await githubAppPrivateKey(options, env, context)), options.userAgent),
    method: "POST",
  })
  const body = await response.json().catch(() => undefined)
  const token = isRecord(body) && typeof body.token === "string" ? body.token : undefined
  if (!token) throw new Error("[vitehub] GitHub App installation token response did not include token.")
  const expiresAt = isRecord(body) && typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Date.now() + 9 * 60_000
  githubAppTokenCache.set(cacheKey, { expiresAt, token })
  return token
}

async function githubPullRequestMetadataToken<TRuntimeConfig extends AgentRuntimeConfig>(
  app: true | GitHubAppOptions<TRuntimeConfig> | undefined,
  context: GitHubAppContext<TRuntimeConfig>,
  installation?: number,
) {
  const env = await githubEnv(context)
  const token = cleanSecret(env.token)
  if (!app) return token
  try {
    return await githubAppInstallationToken(app, context, installation)
  }
  catch (error) {
    if (token) return token
    throw error
  }
}

async function githubAppWebhookSecret<TRuntimeConfig extends AgentRuntimeConfig>(
  app: true | GitHubAppOptions<TRuntimeConfig>,
  context: AgentCallbackContext<TRuntimeConfig>,
): Promise<string | false> {
  const options = githubAppOptions(app) || {}
  const env = await githubEnv(context)
  const secret = await githubAppSetting<false | string | { unseal: () => string } | undefined, TRuntimeConfig>(options, env, "webhookSecret", "webhookSecret", context)
  if (secret === false) return false
  return cleanSecret(secret) || ""
}

function staticGithubAppWebhookSecret<TRuntimeConfig extends AgentRuntimeConfig>(
  app: true | GitHubAppOptions<TRuntimeConfig>,
): string | false | undefined {
  if (app === true) return
  const secret = app.webhookSecret
  if (secret === false) return false
  if (typeof secret === "function") return
  return cleanSecret(secret)
}

function githubAppWebhookSecretToken<TRuntimeConfig extends AgentRuntimeConfig>(
  app: true | GitHubAppOptions<TRuntimeConfig>,
): AgentWebhookSecretToken<TRuntimeConfig> {
  const staticSecret = staticGithubAppWebhookSecret(app)
  if (staticSecret !== undefined) return staticSecret
  return context => githubAppWebhookSecret(app, context)
}

function githubApiHeaders(token?: string, userAgent?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
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

async function githubApiJson(fetcher: typeof fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetcher(url, { headers, method: "GET" })
  if (!response.ok) throw new Error(`[vitehub] GitHub metadata request failed with ${response.status}.`)
  return await response.json().catch(() => undefined)
}

async function githubApiJsonPages(fetcher: typeof fetch, url: string, headers: Record<string, string>, limit: number): Promise<unknown[]> {
  const items: unknown[] = []
  let page = 1
  let nextUrl: string | undefined = githubApiPageUrl(url, page)
  while (nextUrl && (limit <= 0 || items.length < limit)) {
    const response = await fetcher(nextUrl, { headers, method: "GET" })
    if (!response.ok) throw new Error(`[vitehub] GitHub metadata request failed with ${response.status}.`)
    const pageItems = await response.json().catch(() => undefined)
    if (!Array.isArray(pageItems) || !pageItems.length) break
    items.push(...pageItems)
    if (limit > 0 && items.length >= limit) break
    nextUrl = githubApiNextPageUrl(response.headers.get("link")) || githubApiPageUrl(url, ++page)
  }
  return limit > 0 ? items.slice(0, limit) : []
}

function githubApiPageUrl(url: string, page: number): string {
  const parsed = new URL(url)
  parsed.searchParams.set("per_page", "100")
  if (page > 1) parsed.searchParams.set("page", String(page))
  return parsed.toString()
}

function githubApiNextPageUrl(link: string | null): string | undefined {
  return link?.split(",").map(part => part.trim()).find(part => part.endsWith(`rel="next"`))?.match(/^<([^>]+)>/)?.[1]
}

function reactionContent<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string {
  if (typeof context.effect.payload === "string") return context.effect.payload
  if (isRecord(context.effect.payload) && typeof context.effect.payload.content === "string") return context.effect.payload.content
  if (isRecord(context.effect.payload) && typeof context.effect.payload.emoji === "string") return context.effect.payload.emoji
  if (context.effect.intent === "completed") return "hooray"
  if (context.effect.intent === "failed") return "confused"
  return "eyes"
}

function reactionAction<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string | undefined {
  return isRecord(context.effect.payload) ? maybeString(context.effect.payload.action) : undefined
}

function transientReactionKey<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string | undefined {
  return maybeString(context.effect.metadata?.transientKey)
}

type GitHubTransientReaction = {
  id: number
}

function transientReactionStore(input: AgentRunInput): Record<string, GitHubTransientReaction> {
  const context = input.context as Record<string, unknown> | undefined
  if (!context) return {}
  const key = "github.delivery.transientReactions"
  if (!isRecord(context[key])) context[key] = {}
  return context[key] as Record<string, GitHubTransientReaction>
}

function replyBody<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): string | undefined {
  if (typeof context.effect.payload === "string") return context.effect.payload
  if (isRecord(context.effect.payload) && typeof context.effect.payload.body === "string") return context.effect.payload.body
  if (isRecord(context.effect.payload) && typeof context.effect.payload.markdown === "string") return context.effect.payload.markdown
  if (typeof context.effect.metadata?.body === "string") return context.effect.metadata.body
  if (typeof context.effect.metadata?.markdown === "string") return context.effect.metadata.markdown
}

function normalizedDeliveryArtifactPath(path: string): string | undefined {
  try {
    return normalizeDeliveryArtifactPath(path)
  }
  catch {
    return
  }
}

function replyBodyWithLinkArtifacts(body: string | undefined, artifacts: readonly PublishedAgentDeliveryArtifact[]): string | undefined {
  const referencedPaths = new Set(deliveryArtifactMarkdownReferencePaths(body, artifacts))
  const links = artifacts.flatMap((artifact) => {
    const path = normalizedDeliveryArtifactPath(artifact.path)
    if (artifact.placement !== "link" || !artifact.url || (path && referencedPaths.has(path))) return []
    const label = (artifact.alt || artifact.path.split("/").pop() || artifact.path).replace(/[\r\n\[\]]+/g, " ").trim() || "Artifact"
    const url = artifact.url.replace(/[\r\n<>]+/g, "")
    return url ? [`[${label}](<${url}>)`] : []
  })
  if (!links.length) return body
  return body ? `${body}\n\n${links.join("\n")}` : links.join("\n")
}

function deliveryArtifacts<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): PublishedAgentDeliveryArtifact[] {
  const artifacts = [
    ...(Array.isArray(context.effect.artifacts) ? context.effect.artifacts : []),
    ...(isRecord(context.effect.payload) && Array.isArray(context.effect.payload.artifacts) ? context.effect.payload.artifacts : []),
  ]
  return publishedDeliveryArtifactsFromUnknown(artifacts)
}

function deliveryArtifactFilename(artifact: PublishedAgentDeliveryArtifact): string {
  return artifact.path.split("/").filter(Boolean).at(-1) || "artifact"
}

function arrayBufferContent(value: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function deliveryArtifactFiles<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  artifacts: readonly PublishedAgentDeliveryArtifact[],
): Promise<FileUpload[]> {
  if (!context.workspace) return []
  const files: FileUpload[] = []
  for (const artifact of artifacts) {
    if (artifact.url || artifact.placement === "link") continue
    const path = normalizeDeliveryArtifactPath(artifact.path, "Delivery artifact path")
    const stat = await context.workspace.fs.stat(path).catch(() => undefined)
    if (stat && stat.type !== "file") continue
    const mediaType = artifact.mediaType || stat?.mediaType
    const content = await context.workspace.fs.readFile(path, { encoding: "binary" })
    files.push({
      data: arrayBufferContent(content as ArrayBuffer | Uint8Array | string),
      filename: deliveryArtifactFilename(artifact),
      ...(mediaType ? { mimeType: mediaType } : {}),
    })
  }
  return files
}

async function messageChannelReplyEffect<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): Promise<void> {
  const artifacts = deliveryArtifacts(context)
  const attachments = deliveryArtifactAttachments(artifacts)
  const files = await deliveryArtifactFiles(context, artifacts)
  const stream = isAsyncIterable(context.effect.payload)
    ? context.effect.payload as AgentChannelDeliveryReplyStream
    : undefined
  if (stream && !artifacts.length) {
    const chat = context.finish
      ? chatFinishExtensionFromUnknown(context.finish.extensions.get("chat")) || chatFinishExtension(context.input)
      : undefined
    if (chat) {
      await chat.sendMessage(stream)
      return
    }
    const adapter = context.channel.adapter
      ? await resolveEffectOption(context.channel.adapter as MaybeResolvable<Adapter, AgentChannelDeliveryEffectContext<TRuntimeConfig>>, context)
      : undefined
    if (adapter && context.run?.threadId) {
      try {
        await clearMessageChannelProgress({ ...context, adapter })
      }
      catch {
        console.warn("[vitehub] failed to clear message Channel progress.")
      }
      const threadId = adapter.channelIdFromThreadId(context.run.threadId)
      if (adapter.stream && await adapter.stream(threadId, stream) !== null) return
      let body = ""
      for await (const chunk of stream) body += chunk
      if (body) await adapter.postMessage(threadId, { markdown: body })
    }
    return
  }
  let body = replyBody(context)
  if (stream) {
    for await (const chunk of stream) body = `${body || ""}${chunk}`
  }
  body = rewriteDeliveryArtifactMarkdown(replyBodyWithLinkArtifacts(body, artifacts), artifacts)
  if (!body && !attachments.length && !files.length) return
  const message: AgentChatMessage = {
    markdown: body || "",
    ...(attachments.length ? { attachments } : {}),
    ...(files.length ? { files } : {}),
  }
  const chat = context.finish
    ? chatFinishExtensionFromUnknown(context.finish.extensions.get("chat")) || chatFinishExtension(context.input)
    : undefined
  if (chat) {
    await chat.sendMessage(message)
    return
  }
  const adapter = context.channel.adapter
    ? await resolveEffectOption(context.channel.adapter as MaybeResolvable<Adapter, AgentChannelDeliveryEffectContext<TRuntimeConfig>>, context)
    : undefined
  if (adapter && context.run?.threadId) {
    const progress = context.context.get<MessageChannelProgressReference>(messageChannelProgressContextKey)
    if (progress && context.context.get<boolean>(messageChannelProgressClearedContextKey) !== true) {
      if (progress.reusable !== false && context.effect.intent === "chat.error-fallback" && adapter.editMessage && !attachments.length && !files.length) {
        try {
          await adapter.editMessage(progress.threadId, progress.messageId, message)
          context.context.set(messageChannelProgressClearedContextKey, true, { overwrite: true })
          return
        }
        catch {
          // Fall through to delete-then-post so a failed edit does not suppress the fallback.
        }
      }
      try {
        await clearMessageChannelProgress({ ...context, adapter })
      }
      catch {
        if (progress.reusable !== false && adapter.editMessage && !attachments.length && !files.length) {
          await adapter.editMessage(progress.threadId, progress.messageId, message)
          context.context.set(messageChannelProgressClearedContextKey, true, { overwrite: true })
          return
        }
      }
    }
    await adapter.postMessage(adapter.channelIdFromThreadId(context.run.threadId), message)
  }
}

function titleEffectPayloadTitle(value: unknown): string | undefined {
  const title = typeof value === "string" ? value : isRecord(value) ? value.title : undefined
  return typeof title === "string" ? maybeString(title.trim()) : undefined
}

type ThreadTitleAdapter = Adapter & {
  setThreadTitle?: (threadId: string, title: string) => MaybePromise<unknown>
}

type AssistantTitleAdapter = Adapter & {
  setAssistantTitle?: (channelId: string, threadTs: string, title: string) => MaybePromise<unknown>
}

function adapterSetThreadTitle(adapter: Adapter | undefined) {
  const setThreadTitle = (adapter as ThreadTitleAdapter | undefined)?.setThreadTitle
  return typeof setThreadTitle === "function" ? setThreadTitle.bind(adapter) : undefined
}

function adapterSetAssistantTitle(adapter: Adapter | undefined) {
  const setAssistantTitle = (adapter as AssistantTitleAdapter | undefined)?.setAssistantTitle
  return typeof setAssistantTitle === "function" ? setAssistantTitle.bind(adapter) : undefined
}

async function messageChannelTitleAdapter<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): Promise<Adapter | undefined> {
  return context.channel.adapter
    ? await resolveEffectOption(context.channel.adapter as MaybeResolvable<Adapter, AgentChannelDeliveryEffectContext<TRuntimeConfig>>, context)
    : undefined
}

export async function messageChannelSupportsTitleEffect<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): Promise<boolean> {
  if (!context.run?.threadId) return false
  const adapter = await messageChannelTitleAdapter(context)
  return Boolean(adapterSetThreadTitle(adapter) || adapterSetAssistantTitle(adapter))
}

export function channelHasCustomTitleEffect<TRuntimeConfig extends AgentRuntimeConfig>(
  channel: AgentChannelDefinition<TRuntimeConfig>,
): boolean {
  const titleEffect = channel.effects?.title
  return customTitleEffectChannels.has(channel)
    || Boolean(titleEffect && titleEffect !== messageChannelTitleEffect)
}

async function messageChannelTitleEffect<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): Promise<void> {
  const title = titleEffectPayloadTitle(context.effect.payload)
  if (!title || !context.run?.threadId) return
  const adapter = await messageChannelTitleAdapter(context)
  const setThreadTitle = adapterSetThreadTitle(adapter)
  if (setThreadTitle) {
    await setThreadTitle(context.run.threadId, title)
    return
  }
  const setAssistantTitle = adapterSetAssistantTitle(adapter)
  if (adapter && setAssistantTitle) {
    await setAssistantTitle(adapter.channelIdFromThreadId(context.run.threadId), context.run.threadId, title)
  }
}

function messageChannelDeliveryEffects<TRuntimeConfig extends AgentRuntimeConfig>(
  effects: AgentChannelDeliveryEffects<TRuntimeConfig> | undefined,
): AgentChannelDeliveryEffects<TRuntimeConfig> {
  return {
    ...effects,
    reply: effects?.reply ?? messageChannelReplyEffect,
    title: effects?.title ?? messageChannelTitleEffect,
  }
}

function githubMarkdownText(value: string): string {
  return value.replace(/[\r\n\[\]]+/g, " ").trim() || "Artifact"
}

function githubMarkdownUrl(value: string): string {
  return value.replace(/[\r\n<>]+/g, "")
}

const imageArtifactExtensions = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"])
let githubArtifactPublishCounter = 0

function isImageArtifactPath(value: string): boolean {
  return imageArtifactExtensions.has(value.split(".").pop()?.toLowerCase() || "")
}

function githubBodyImagePath(value: string): string | undefined {
  if (!isImageArtifactPath(value)) return
  try {
    return normalizeDeliveryArtifactPath(value, "GitHub delivery image path")
  }
  catch {
    return
  }
}

async function existingWorkspaceImagePath<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  path: string,
): Promise<string | undefined> {
  const normalized = githubBodyImagePath(path)
  if (!normalized || !context.workspace) return
  const stat = await context.workspace.fs.stat(normalized).catch(() => undefined)
  if (!stat || stat.type !== "file") return
  return normalized
}

async function githubBodyImageArtifacts<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  body: string | undefined,
  options: GitHubPullRequestEffectsOptions<TRuntimeConfig>,
  command: GitHubPullRequestCommand,
  headers: Record<string, string>,
): Promise<PublishedAgentDeliveryArtifact[]> {
  if (!body || !context.workspace || options.artifacts === false) return []
  const paths = new Set<string>()
  const collect = async (value: string) => {
    const path = await existingWorkspaceImagePath(context, value)
    if (path) paths.add(path)
  }
  for (const match of body.matchAll(/!\[[^\]\r\n]*\]\(\s*<?(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.(?:gif|jpe?g|png|svg|webp))>?\s*\)/gi)) {
    await collect(match[1])
  }
  for (const match of body.matchAll(/(?<!!)\[[^\]\r\n]*\]\(\s*<?(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.(?:gif|jpe?g|png|svg|webp))>?\s*\)/gi)) {
    await collect(match[1])
  }
  for (const match of body.matchAll(/(^|\s)((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:gif|jpe?g|png|svg|webp))(?![\w.-])/gi)) {
    await collect(match[2])
  }
  if (!paths.size) return []
  const branch = options.artifacts && options.artifacts.branch || "vitehub-agent-assets"
  const pathPrefix = options.artifacts && options.artifacts.pathPrefix || "vitehub-agent-assets"
  const fetcher = options.fetch || fetch
  await ensureGitHubArtifactBranch(fetcher, options.apiBaseUrl, command, headers, branch)
  return await publishWorkspaceArtifacts(context, [...paths].map(path => ({ path, placement: "inline" })), {
    prefix: `${pathPrefix}/pr-${command.issueNumber}/${context.run?.runId || command.commentId}`,
    publish: async input => await publishGitHubArtifact(fetcher, options.apiBaseUrl, command, headers, branch, input),
  })
}

async function ensureGitHubArtifactBranch(
  fetcher: typeof fetch,
  apiBaseUrl: string | undefined,
  command: GitHubPullRequestCommand,
  headers: Record<string, string>,
  branch: string,
): Promise<void> {
  const baseUrl = apiBaseUrl || "https://api.github.com"
  const refUrl = `${baseUrl}/repos/${command.owner}/${command.repo}/git/ref/heads/${encodeURIComponent(branch)}`
  const existing = await fetcher(refUrl, { headers, method: "GET" })
  if (existing.ok) return
  if (existing.status !== 404) throw new Error(`[vitehub] GitHub delivery effect failed with ${existing.status}.`)
  const sha = await githubPullRequestBaseSha(fetcher, command, headers)
  if (!sha) throw new Error("[vitehub] GitHub delivery artifact publishing requires a pull request base SHA.")
  const created = await fetcher(`${baseUrl}/repos/${command.owner}/${command.repo}/git/refs`, {
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    headers,
    method: "POST",
  })
  if (!created.ok && created.status !== 422) throw new Error(`[vitehub] GitHub delivery effect failed with ${created.status}.`)
}

function githubWebBaseUrl(apiBaseUrl: string | undefined): string {
  if (!apiBaseUrl) return "https://github.com"
  const url = new URL(apiBaseUrl)
  if (url.hostname === "api.github.com") return "https://github.com"
  if (url.pathname === "/api/v3" || url.pathname.startsWith("/api/v3/")) return url.origin
  if (url.hostname.startsWith("api.")) {
    url.hostname = url.hostname.slice(4)
    return url.origin
  }
  return url.origin
}

function githubRawUrl(apiBaseUrl: string | undefined, command: GitHubPullRequestCommand, branch: string, pathname: string): string {
  return `${githubWebBaseUrl(apiBaseUrl)}/${command.owner}/${command.repo}/raw/${encodeURIComponent(branch)}/${pathname.split("/").map(encodeURIComponent).join("/")}`
}

async function publishGitHubArtifact(
  fetcher: typeof fetch,
  apiBaseUrl: string | undefined,
  command: GitHubPullRequestCommand,
  headers: Record<string, string>,
  branch: string,
  input: AgentDeliveryArtifactPublishInput,
): Promise<AgentDeliveryArtifactPublishResult> {
  const hash = createHash("sha256").update(input.content).digest("hex").slice(0, 12)
  const parts = input.pathname.split("/")
  const filename = parts.pop() || input.artifact.path.split("/").pop() || "artifact"
  const pathname = [...parts, `${Date.now()}-${++githubArtifactPublishCounter}-${hash}`, filename].join("/")
  await githubApi(fetcher, `${apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/contents/${pathname.split("/").map(encodeURIComponent).join("/")}`, {
    body: JSON.stringify({
      branch,
      content: Buffer.from(input.content).toString("base64"),
      message: `chore: publish agent delivery artifact ${input.artifact.path} [skip ci]`,
    }),
    headers,
    method: "PUT",
  })
  return { url: githubRawUrl(apiBaseUrl, command, branch, pathname) }
}

function githubArtifactMarkdown(artifact: PublishedAgentDeliveryArtifact): string | undefined {
  if (!artifact.url) return
  const label = githubMarkdownText(artifact.alt || artifact.path.split("/").pop() || artifact.path)
  const url = githubMarkdownUrl(artifact.url)
  if (!url || artifact.placement === "attachment") return
  if ((artifact.placement || (artifact.mediaType?.startsWith("image/") ? "inline" : "link")) === "inline") {
    return `![${label}](<${url}>)`
  }
  return `[${label}](<${url}>)`
}

async function githubBodyWithArtifacts<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  body: string | undefined,
  options: GitHubPullRequestEffectsOptions<TRuntimeConfig>,
  command: GitHubPullRequestCommand,
  headers: Record<string, string>,
): Promise<string | undefined> {
  const structuredArtifacts = deliveryArtifacts(context)
  const referencedStructuredPaths = new Set(deliveryArtifactMarkdownReferencePaths(body, structuredArtifacts))
  const structuredBody = rewriteDeliveryArtifactMarkdown(body || "", structuredArtifacts) || ""
  const bodyArtifacts = await githubBodyImageArtifacts(context, structuredBody, options, command, headers)
  const rewrittenBody = bodyArtifacts.reduce((text, artifact) => {
    const markdown = githubArtifactMarkdown(artifact)
    if (!markdown || !artifact.url) return text
    const path = artifact.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const url = githubMarkdownUrl(artifact.url!)
    return text
      .replace(new RegExp(`!\\[([^\\]\\r\\n]*)\\]\\(\\s*<?(?:\\./)?${path}>?\\s*\\)`, "g"), (_match, alt) => `![${githubMarkdownText(alt || artifact.alt || artifact.path)}](<${url}>)`)
      .replace(new RegExp(`(?<!!)\\[([^\\]\\r\\n]*)\\]\\(\\s*<?(?:\\./)?${path}>?\\s*\\)`, "g"), (_match, label) => `[${githubMarkdownText(label || artifact.alt || artifact.path)}](<${url}>)`)
      .replace(new RegExp(`(^|\\s)(?:\\./)?${path}(?![\\w.-])`, "g"), (_match, prefix) => `${prefix}${markdown}`)
  }, structuredBody)
  const explicitArtifacts = structuredArtifacts.flatMap((artifact) => {
    const path = normalizedDeliveryArtifactPath(artifact.path)
    if (path && referencedStructuredPaths.has(path)) return []
    const markdown = githubArtifactMarkdown(artifact)
    return markdown ? [markdown] : []
  })
  if (!explicitArtifacts.length) return rewrittenBody || body
  return rewrittenBody ? `${rewrittenBody}\n\n${explicitArtifacts.join("\n")}` : explicitArtifacts.join("\n")
}

function githubPullRequestCommentReplyEffect(context: AgentChannelDeliveryFinishEffectContext): AgentChannelDeliveryEffectIntent | undefined {
  const text = context.result?.text ?? context.text
  if (!text) return
  const body = text.trim() || "_No reply generated._"
  return context.reply(body)
}

function githubPullRequestCommentFinishEffects(
  options: GitHubPullRequestCommentEventOptions,
): AgentChannelDeliveryFinishEffect | undefined {
  if (options.reply === false) return
  return options.reply === true || options.reply === undefined
    ? githubPullRequestCommentReplyEffect
    : options.reply
}

function statusPayload<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  defaultContext: string,
): GitHubPullRequestStatusPayload {
  const payload = isRecord(context.effect.payload)
    ? context.effect.payload
    : typeof context.effect.payload === "string"
      ? { state: context.effect.payload }
      : {}
  return {
    context: payload.context || context.effect.metadata?.context || defaultContext,
    description: payload.description || context.effect.metadata?.description,
    sha: payload.sha || context.effect.metadata?.sha,
    state: payload.state || context.effect.metadata?.state || (context.effect.intent === "failed" ? "failure" : context.effect.intent === "completed" ? "success" : "pending"),
    target_url: payload.target_url || context.effect.metadata?.target_url,
  }
}

async function githubPullRequestSha(
  fetcher: typeof fetch,
  command: GitHubPullRequestCommand,
  headers: Record<string, string>,
  key: "base" | "head",
): Promise<string | undefined> {
  const response = await githubApi(fetcher, command.pullRequestUrl, { headers, method: "GET" })
  const payload = await response.json().catch(() => undefined)
  return isRecord(payload) && isRecord(payload[key]) ? maybeString(payload[key].sha) : undefined
}

async function githubPullRequestBaseSha(
  fetcher: typeof fetch,
  command: GitHubPullRequestCommand,
  headers: Record<string, string>,
): Promise<string | undefined> {
  return await githubPullRequestSha(fetcher, command, headers, "base")
}

async function githubPullRequestHeadSha(
  fetcher: typeof fetch,
  command: GitHubPullRequestCommand,
  headers: Record<string, string>,
): Promise<string | undefined> {
  return await githubPullRequestSha(fetcher, command, headers, "head")
}

function githubPullRequestEffects<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: GitHubPullRequestEffectsOptions<TRuntimeConfig>,
): AgentChannelDeliveryEffects<TRuntimeConfig> {
  return {
    async reaction(context) {
      const command = githubCommandFromEffect(context)
      if (!command) return
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/issues/comments/${command.commentId}/reactions`
      const key = transientReactionKey(context)
      if (reactionAction(context) === "remove") {
        const id = key ? transientReactionStore(context.input)[key]?.id : undefined
        if (!id) return
        await githubApi(fetcher, `${url}/${id}`, {
          headers: githubApiHeaders(token, options.userAgent),
          method: "DELETE",
        })
        delete transientReactionStore(context.input)[key!]
        return
      }
      const response = await githubApi(fetcher, url, {
        body: JSON.stringify({ content: reactionContent(context) }),
        headers: githubApiHeaders(token, options.userAgent),
        method: "POST",
      })
      const body = await response.json().catch(() => undefined)
      const id = isRecord(body) ? maybeNumber(body.id) : undefined
      if (key && id) transientReactionStore(context.input)[key] = { id }
    },
    async reply(context) {
      const command = githubCommandFromEffect(context)
      if (!command) return
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const headers = githubApiHeaders(token, options.userAgent)
      const body = await githubBodyWithArtifacts(context, replyBody(context), options, command, headers)
      if (!body) return
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/issues/${command.issueNumber}/comments`
      await githubApi(fetcher, url, {
        body: JSON.stringify({ body }),
        headers,
        method: "POST",
      })
    },
    async update(context) {
      const command = githubCommandFromEffect(context)
      if (!command) return
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const headers = githubApiHeaders(token, options.userAgent)
      const body = await githubBodyWithArtifacts(context, replyBody(context), options, command, headers)
      if (!body) return
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/issues/comments/${command.commentId}`
      await githubApi(fetcher, url, {
        body: JSON.stringify({ body }),
        headers,
        method: "PATCH",
      })
    },
    async review(context) {
      const command = githubCommandFromEffect(context)
      if (!command) return
      const payload = isRecord(context.effect.payload) ? context.effect.payload : {}
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const headers = githubApiHeaders(token, options.userAgent)
      const body = await githubBodyWithArtifacts(context, replyBody(context), options, command, headers)
      if (!body) return
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/pulls/${command.issueNumber}/reviews`
      await githubApi(fetcher, url, {
        body: JSON.stringify({
          body,
          event: maybeString(payload.event) || maybeString(context.effect.metadata?.event) || "COMMENT",
        }),
        headers,
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
  app?: true | GitHubAppOptions<TRuntimeConfig>,
): AgentChannelDefinition<TRuntimeConfig>["webhooks"] {
  const defaults = {
    secretHeader: "x-hub-signature-256",
    ...(app ? { secretToken: githubAppWebhookSecretToken(app) } : {}),
    signature: "github-sha256" as const,
  }
  if (webhooks === undefined || webhooks === true) return defaults
  if (webhooks === false) return false
  const apply = (webhook: AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>) => ({ ...defaults, ...webhook })
  return Array.isArray(webhooks) ? webhooks.map(apply) : apply(webhooks)
}

function telegramWebhookDefaults<TRuntimeConfig extends AgentRuntimeConfig>(
  webhooks: AgentChannelDefinition<TRuntimeConfig>["webhooks"],
): AgentChannelDefinition<TRuntimeConfig>["webhooks"] {
  const defaults = {
    secretHeader: "x-telegram-bot-api-secret-token",
    secretToken: (context: AgentCallbackContext<TRuntimeConfig>) =>
      cleanSecret(runtimeEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", context)),
  }
  if (webhooks === undefined || webhooks === true) return defaults
  if (webhooks === false) return false
  const apply = (webhook: AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>) => ({ ...defaults, ...webhook })
  return Array.isArray(webhooks) ? webhooks.map(apply) : apply(webhooks)
}

function telegramAdapterResolver<TRuntimeConfig extends AgentRuntimeConfig>(
  options: TelegramChannelOptions<TRuntimeConfig>,
): AgentChannelOptions<TRuntimeConfig>["adapter"] {
  if (options.adapter) return options.adapter
  return async context => {
    const [
      allowedUserIds,
      apiBaseUrl,
      apiUrl,
      botToken,
      longPolling,
      userName,
      webhookSecret,
    ] = await Promise.all([
      options.allowedUserIds === undefined ? undefined : resolveRuntimeValue(options.allowedUserIds, context),
      options.apiBaseUrl === undefined ? undefined : resolveRuntimeValue(options.apiBaseUrl, context),
      options.apiUrl === undefined ? undefined : resolveRuntimeValue(options.apiUrl, context),
      options.botToken === undefined ? runtimeEnv("TELEGRAM_BOT_TOKEN", context) : resolveRuntimeValue(options.botToken, context),
      options.longPolling === undefined ? undefined : resolveRuntimeValue(options.longPolling, context),
      options.userName === undefined ? undefined : resolveRuntimeValue(options.userName, context),
      options.webhookSecret === undefined ? runtimeEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", context) : resolveRuntimeValue(options.webhookSecret, context),
    ])
    const { createTelegramAdapter } = await import("@chat-adapter/telegram")
    return createTelegramAdapter({
      ...(allowedUserIds ? { allowedUserIds } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(apiUrl ? { apiUrl } : {}),
      ...(botToken ? { botToken: cleanSecret(botToken) } : {}),
      ...(longPolling ? { longPolling } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(userName ? { userName } : {}),
      ...(webhookSecret ? { secretToken: cleanSecret(webhookSecret) } : {}),
    })
  }
}

function telegramWebhookSecretToken<TRuntimeConfig extends AgentRuntimeConfig>(
  secret: NonNullable<TelegramChannelOptions<TRuntimeConfig>["webhookSecret"]>,
): AgentWebhookSecretToken<TRuntimeConfig> {
  return async context => {
    const resolved = await resolveRuntimeValue(secret, context)
    return resolved === undefined || resolved === false ? false : cleanSecret(resolved) || false
  }
}

function discordAdapterResolver<TRuntimeConfig extends AgentRuntimeConfig>(
  input: true | DiscordAdapterOptions | AgentChannelOptions<TRuntimeConfig>["adapter"] | undefined,
): AgentChannelOptions<TRuntimeConfig>["adapter"] | undefined {
  if (input === undefined) return undefined
  if (input !== true && (typeof input === "function" || isAdapter(input) || isResolver(input))) {
    return input as AgentChannelOptions<TRuntimeConfig>["adapter"]
  }
  const options: DiscordAdapterOptions = input === true ? {} : input
  const { longContent, ...adapterOptions } = options
  return async () => {
    let createDiscordAdapter: (options?: Record<string, unknown>) => Adapter
    try {
      ({ createDiscordAdapter } = await import("@chat-adapter/discord"))
    }
    catch (error) {
      throw new Error("[vitehub] discord({ adapter: true }) requires @chat-adapter/discord to be installed.", { cause: error })
    }
    const botToken = cleanSecret(adapterOptions.botToken)
    const adapter = createDiscordAdapter({
      ...adapterOptions,
      ...(botToken ? { botToken } : {}),
      ...(adapterOptions.publicKey ? { publicKey: cleanSecret(adapterOptions.publicKey) } : {}),
    })
    addDiscordThreadTitleSupport(adapter, adapterOptions, botToken)
    if (longContent?.mode === "split") {
      Object.defineProperty(adapter, Symbol.for("vitehub.discord.longContent.mode"), {
        configurable: true,
        value: "split",
      })
    }
    return adapter
  }
}

const discordApiBaseUrl = "https://discord.com/api/v10"

function discordThreadIdFromAgentThreadId(threadId: string): string | undefined {
  const parts = threadId.split(":")
  return parts[0] === "discord" ? maybeString(parts[3]) : undefined
}

function addDiscordThreadTitleSupport(adapter: Adapter, options: DiscordAdapterOptions, botToken: string | undefined): void {
  if (!botToken || adapterSetThreadTitle(adapter)) return
  Object.defineProperty(adapter, "setThreadTitle", {
    configurable: true,
    value: async (threadId: string, title: string) => {
      const discordThreadId = discordThreadIdFromAgentThreadId(threadId)
      const name = title.replace(/\s+/g, " ").trim().slice(0, 100).trim()
      if (!discordThreadId || !name) return
      const response = await fetch(`${(options.apiUrl || discordApiBaseUrl).replace(/\/+$/, "")}/channels/${discordThreadId}`, {
        body: JSON.stringify({ name }),
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
        },
        method: "PATCH",
      })
      if (!response.ok) {
        const error = await response.text().catch(() => response.statusText)
        throw new Error(`[vitehub] Discord thread title update failed: ${response.status}${error ? ` ${error}` : ""}`)
      }
    },
  })
}

function isAdapter(value: unknown): value is AgentChatPlatformAdapter {
  return isRecord(value) && typeof value.postMessage === "function"
}

function isResolver(value: unknown): value is { resolve: (context: AgentCallbackContext) => MaybePromise<AgentChatPlatformAdapter> } {
  return isRecord(value) && typeof value.resolve === "function"
}

function ignored(reason: string) {
  return Response.json({ accepted: false, ok: true, reason })
}

function githubPullRequestRunContextFromInput(input: unknown): GitHubPullRequestRunContext | undefined {
  return githubPullRequestRunContextFromUnknown(input)
}

function githubCommandFromRunContext(value: GitHubPullRequestRunContext): GitHubPullRequestCommand | undefined {
  const repository = maybeString(value.repository.fullName)
  const [fallbackOwner, fallbackRepo] = repository?.split("/") || []
  const owner = maybeString(value.repository.owner) || fallbackOwner
  const repo = maybeString(value.repository.name) || fallbackRepo
  const issueNumber = maybeNumber(value.pullRequest.number)
  const commentId = maybeNumber(value.trigger.comment.id)
  const pullRequestUrl = maybeString(value.pullRequest.apiUrl)
  const login = maybeString(value.trigger.actor.login)
  if (!repository || !owner || !repo || !issueNumber || !commentId || !pullRequestUrl || !login) return
  return {
    action: value.trigger.action,
    actor: value.trigger.actor,
    args: value.trigger.args,
    body: maybeString(value.trigger.comment.body) || value.trigger.command,
    command: value.trigger.command,
    commentId,
    ...(maybeString(value.trigger.comment.nodeId) ? { commentNodeId: maybeString(value.trigger.comment.nodeId) } : {}),
    ...(maybeString(value.trigger.deliveryId) ? { deliveryId: maybeString(value.trigger.deliveryId) } : {}),
    ...(maybeNumber(value.trigger.installationId) ? { installationId: maybeNumber(value.trigger.installationId) } : {}),
    issueNumber,
    owner,
    pullRequestUrl,
    repo,
    repository,
  }
}

function githubPullRequestDevPrompt(input: Record<string, unknown>, pullRequest: GitHubPullRequestRunContext): string {
  const command = maybeString(pullRequest.trigger.command)
  const args = maybeString(pullRequest.trigger.args)
  return maybeString(input.prompt) || maybeString(pullRequest.trigger.comment.body) || (command && args ? `${command} ${args}` : command) || "/review"
}

function githubDevPayload(input: unknown): GitHubIssueCommentPayload | undefined {
  const payload = inputPayloadOrBody(input)
  if (payload) return payload
  if (!isRecord(input) || !isRecord(input.issue) || !isRecord(input.comment)) return
  return input as GitHubIssueCommentPayload
}

function githubEventTriggers<TRuntimeConfig extends AgentRuntimeConfig>(
  pullRequest: boolean | GitHubPullRequestCommentEventOptions<TRuntimeConfig> | undefined,
  app?: true | GitHubAppOptions<TRuntimeConfig>,
): AgentChannelDefinition<TRuntimeConfig>["triggers"] {
  if (!pullRequest) return undefined
  const options = pullRequest === true ? {} : pullRequest
  return {
    webhook: {
      async invoke(context, input): Promise<AgentTriggerInvokeResult> {
        const payload = inputPayloadOrBody(input)
        const command = githubPullRequestCommandFromInput(isRecord(input) ? { ...input, payload } : { payload })
        if (!payload && !command) return options.ignored?.("missing_payload") || ignored("missing_payload")
        if (!command) return options.ignored?.("not_command") || ignored("not_command")
        if (declaredInputCommand(context, command.command) === false) return options.ignored?.("not_command") || ignored("not_command")
        const metadata = await githubPullRequestMetadata(app, context, command, options, payload)
        const pullRequest = githubPullRequestRunContext(command, {
          ...options,
          threadId: options.threadId || maybeString(payload?.issue?.pull_request?.html_url) || maybeString(payload?.issue?.html_url) || command.pullRequestUrl,
        }, payload, metadata)
        const finishEffects = githubPullRequestCommentFinishEffects(options)
        return {
          ...(finishEffects ? { delivery: { finishEffects } } : {}),
          input: pullRequestCommandInput(command, pullRequest),
          run: {
            ...pullRequest.run,
            channelId: context.trigger.channelId,
          },
        }
      },
    },
    dev: {
      webhooks: [],
      async invoke(context, input): Promise<AgentTriggerInvokeResult> {
        const inputRecord = isRecord(input) ? input : {}
        const finishEffects = githubPullRequestCommentFinishEffects(options)
        const existingPullRequest = githubPullRequestRunContextFromInput(input)
        const controls = {
          ...(inputRecord.abortSignal ? { abortSignal: inputRecord.abortSignal as AbortSignal } : {}),
          ...(typeof inputRecord.timeout === "number" ? { timeout: inputRecord.timeout } : {}),
        }
        if (existingPullRequest) {
          const command = githubCommandFromUnknown(inputRecord.github) || githubCommandFromRunContext(existingPullRequest)
          if (command && declaredInputCommand(context, command.command) === false) return options.ignored?.("not_command") || ignored("not_command")
          return {
            ...(finishEffects ? { delivery: { finishEffects } } : {}),
            input: {
              ...controls,
              context: {
                ...(command ? { github: command } : {}),
                pullRequest: existingPullRequest,
              },
              prompt: githubPullRequestDevPrompt(inputRecord, existingPullRequest),
            },
            run: {
              ...existingPullRequest.run,
              channelId: context.trigger.channelId,
            },
          }
        }

        const payload = githubDevPayload(input)
        const command = githubPullRequestCommandFromInput(isRecord(input) ? { ...input, payload } : { payload })
        if (!payload && !command) return options.ignored?.("missing_payload") || ignored("missing_payload")
        if (!command) return options.ignored?.("not_command") || ignored("not_command")
        if (declaredInputCommand(context, command.command) === false) return options.ignored?.("not_command") || ignored("not_command")
        const metadata = await githubPullRequestMetadata(app, context, command, options, payload)
        const pullRequest = githubPullRequestRunContext(command, {
          ...options,
          threadId: options.threadId || maybeString(payload?.issue?.pull_request?.html_url) || maybeString(payload?.issue?.html_url) || command.pullRequestUrl,
        }, payload, metadata)
        return {
          ...(finishEffects ? { delivery: { finishEffects } } : {}),
          input: {
            ...controls,
            context: {
              github: command,
              pullRequest,
            },
            prompt: maybeString(inputRecord.prompt) || command.body,
          },
          run: {
            ...pullRequest.run,
            channelId: context.trigger.channelId,
          },
        }
      },
    },
  }
}

function githubPullRequestContextValue(input: GitHubPullRequestReadInvocation): PullRequestContextValue {
  const value = pullRequest.read(input)
  if (!value.source?.repo) throw new Error("[vitehub] GitHub pull request workspace requires a repository source.")
  if (!value.source.ref) throw new Error("[vitehub] GitHub pull request workspace requires a source ref.")
  if (!value.head?.sha) throw new Error("[vitehub] GitHub pull request workspace requires the exact head SHA.")
  return value
}

function githubPullRequestInstallationId(value: PullRequestContextValue): number | undefined {
  const installationId = value.trigger?.installationId
  if (typeof installationId === "number") return installationId
  if (typeof installationId !== "string" || !installationId) return
  const parsed = Number(installationId)
  return Number.isFinite(parsed) ? parsed : undefined
}

function githubPullRequestWorkspaceCapability<TRuntimeConfig extends AgentRuntimeConfig>(
  workspace: GitHubPullRequestWorkspacePolicy | undefined,
  app: true | GitHubAppOptions<TRuntimeConfig> | undefined,
): AgentCapabilityDefinition<TRuntimeConfig> | undefined {
  if (!workspace?.enabled) return
  return defineCapability({
    id: "github-pull-request-workspace",
    async workspace(context) {
      const value = githubPullRequestContextValue(context)
      const token = await githubPullRequestMetadataToken(app, context, githubPullRequestInstallationId(value))
      const { github: githubSource } = await import("@vite-hub/workspace")
      return {
        sources: {
          vitehubGitHubPullRequest: githubSource({
            ...(token ? { auth: token } : {}),
            materialize: "lazy",
            mount: { path: workspace.mount },
            ref: value.head!.sha!,
            repo: value.source!.repo!,
          }),
        },
      }
    },
  })
}

export function defineChannel<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  kind: string,
  options: AgentChannelDefinitionOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  if (typeof kind !== "string" || !kind.trim()) {
    throw new TypeError("[vitehub] defineChannel() requires a non-empty Channel kind.")
  }
  const messages: false | AgentMessageChannelSettings<TRuntimeConfig> =
    options.messages === undefined ? {} as AgentMessageChannelSettings<TRuntimeConfig> : options.messages
  const effects = messages !== false && options.adapter
    ? messageChannelDeliveryEffects(options.effects)
    : options.effects
  const channel: AgentChannelDefinition<TRuntimeConfig> = {
    ...options,
    ...(effects ? { effects } : {}),
    kind,
    messages,
  }
  if (options.effects?.title) customTitleEffectChannels.add(channel)
  return channel
}

export function discord<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: DiscordChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("discord", {
    ...options,
    adapter: discordAdapterResolver(options.adapter),
  })
}

export function github<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: GitHubChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  const { app: appOptions, pullRequest, ...channelOptions } = options
  const app = githubAppOptions(appOptions)
  const pullRequestOptions = pullRequest === true ? {} : pullRequest || {}
  const workspace = pullRequest ? githubPullRequestWorkspacePolicy(pullRequestOptions) : undefined
  const workspaceCapability = githubPullRequestWorkspaceCapability(workspace, appOptions)
  const appEffects: AgentChannelDeliveryEffects<TRuntimeConfig> | undefined = appOptions
    ? githubPullRequestEffects<TRuntimeConfig>({
        apiBaseUrl: app?.apiBaseUrl,
        artifacts: app?.artifacts,
        fetch: app?.fetch,
        statusContext: app?.statusContext,
        token: context => githubAppInstallationToken(appOptions, context),
        userAgent: app?.userAgent,
      })
    : undefined
  return defineChannel("github", {
    ...channelOptions,
    capabilities: [
      ...(workspaceCapability ? [workspaceCapability] : []),
      ...channelOptions.capabilities || [],
    ],
    effects: appEffects ? { ...appEffects, ...options.effects } as AgentChannelDeliveryEffects<TRuntimeConfig> : options.effects,
    messages: false,
    triggers: {
      ...githubEventTriggers(pullRequest, appOptions),
      ...options.triggers,
    },
    webhooks: githubWebhookDefaults(options.webhooks, appOptions),
  })
}

export function http<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody,
  TAuth = unknown,
>(
  options: AgentChannelOptions<TRuntimeConfig, TBody, TAuth> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  if ("path" in options) {
    throw new TypeError("[vitehub] http({ path }) is not wired yet. Webhook routes are configured with webhooks.path.")
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

export function telegram<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: TelegramChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  if (options.webhooks !== undefined && options.webhookSecret !== undefined) {
    throw new TypeError("[vitehub] telegram() accepts webhookSecret or webhooks, not both.")
  }
  const {
    adapter: _adapter,
    allowedUserIds: _allowedUserIds,
    apiBaseUrl: _apiBaseUrl,
    apiUrl: _apiUrl,
    botToken: _botToken,
    longPolling: _longPolling,
    mode,
    userName: _userName,
    webhooks,
    webhookSecret,
    ...channelOptions
  } = options
  const webhookOptions = webhookSecret !== undefined
    ? { secretToken: telegramWebhookSecretToken(webhookSecret) }
    : webhooks
  const channel = defineMessageChannelInstructions(defineChannel("telegram", {
    ...channelOptions,
    adapter: telegramAdapterResolver(options),
    ...(mode === "polling" ? { listener: { kind: "telegram-polling" } } : {}),
    webhooks: mode === "polling"
      ? false
      : telegramWebhookDefaults(webhookOptions),
  }), "Write the final response for Telegram. Match the language of the user's latest message. Prefer short paragraphs or bullets and keep the answer concise. Do not use Markdown tables; express rows as bullets because Telegram fallback delivery exposes table syntax. Avoid decorative emoji, redundant restatement, and generic follow-up questions. Follow the Agent's own instructions when they require a different format.")
  const historyChannel = withAgentChannelHistoryDefinition<TRuntimeConfig>(channel, {
    async resolveDefaultThreadId(context, resolvedChannel) {
      const allowedUserIds = options.allowedUserIds === undefined
        ? undefined
        : await resolveRuntimeValue(options.allowedUserIds, context)
      if (allowedUserIds?.length !== 1) return
      const adapter = await resolveRuntimeValue(resolvedChannel.adapter, context)
      if (!adapter?.openDM) return
      return await adapter.openDM(String(allowedUserIds[0]!))
    },
  })
  if (options.adapter) return historyChannel
  return withAgentChannelSyncDefinition<TRuntimeConfig>(historyChannel, {
    provider: "telegram",
    async resolve(context, resolvedChannel) {
      if (resolvedChannel.adapter !== channel.adapter) return
      const resolvedWebhooks = resolvedChannel.webhooks
      const registration = Array.isArray(resolvedWebhooks)
        ? resolvedWebhooks.length === 1 ? resolvedWebhooks[0] : undefined
        : resolvedWebhooks && typeof resolvedWebhooks === "object" ? resolvedWebhooks : undefined
      const secret = registration?.secretToken
      const [apiBaseUrl, apiUrl, botToken, secretToken] = await Promise.all([
        options.apiBaseUrl === undefined ? undefined : resolveRuntimeValue(options.apiBaseUrl, context),
        options.apiUrl === undefined ? undefined : resolveRuntimeValue(options.apiUrl, context),
        options.botToken === undefined ? undefined : resolveRuntimeValue(options.botToken, context),
        secret === undefined ? undefined : resolveRuntimeValue(secret, context),
      ])
      const resolvedBotToken = cleanSecret(botToken) || cleanSecret(runtimeEnv("TELEGRAM_BOT_TOKEN", context))
      if (!resolvedBotToken) {
        throw new TypeError("[vitehub] Telegram Channel synchronization requires telegram({ botToken }) or TELEGRAM_BOT_TOKEN.")
      }
      const resolvedSecretToken = secretToken === false
        ? undefined
        : cleanSecret(secretToken) || cleanSecret(runtimeEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", context))
      return createTelegramChannelSyncProvider({
        apiBaseUrl: cleanSecret(apiUrl) || cleanSecret(apiBaseUrl) || cleanSecret(runtimeEnv("TELEGRAM_API_BASE_URL", context)),
        botToken: resolvedBotToken,
        mode: resolvedChannel.listener?.kind === "telegram-polling" || resolvedWebhooks === false
          ? "disabled"
          : "webhook",
        ...(resolvedSecretToken ? { secretToken: resolvedSecretToken } : {}),
      })
    },
  })
}

export function webChat<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody,
  TAuth = unknown,
>(
  options: AgentWebChatChannelOptions<TRuntimeConfig, TBody, TAuth> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return defineChannel("web-chat", {
    ...options,
    route: options.route ?? true,
  })
}
