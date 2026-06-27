import { createSign } from "node:crypto"

import type {
  AgentCallbackContext,
  AgentCapabilityDefinition,
  AgentChannelDefinition,
  AgentChannelDeliveryEffectContext,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryEffects,
  AgentChannelDeliveryFinishEffect,
  AgentDeliveryArtifact,
  AgentChatWebhookRegistrationDefinition,
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
import type { AgentChannelChatRouteHandlerOptions } from "./server.ts"

export type {
  AgentChannelDeliveryEffectContext,
  AgentChannelDeliveryEffectHandler,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryEffectKind,
  AgentChannelDeliveryEffects,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDeliveryFinishEffectContext,
  AgentChannelDefinition,
  AgentChannels,
  AgentDeliveryArtifact,
  AgentDeliveryArtifactPlacement,
  AgentMessageChannelSettings,
  PublishedAgentDeliveryArtifact,
} from "./types.ts"
export interface AgentChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapter?: AgentChannelDefinition<TRuntimeConfig>["adapter"]
  effects?: AgentChannelDefinition<TRuntimeConfig>["effects"]
  identity?: AgentChannelDefinition<TRuntimeConfig>["identity"]
  messages?: false | AgentMessageChannelSettings<TRuntimeConfig>
  triggers?: AgentChannelDefinition<TRuntimeConfig>["triggers"]
  webhooks?: AgentChannelDefinition<TRuntimeConfig>["webhooks"]
}

type AgentChannelDefinitionOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> =
  Omit<AgentChannelDefinition<TRuntimeConfig>, "kind">

export interface AgentStreamChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentChannelOptions<TRuntimeConfig> {
  route?: true | AgentChannelChatRouteHandlerOptions
}

export interface AgentDeliveryArtifactPublishInput {
  artifact: AgentDeliveryArtifact
  content: Uint8Array
  mediaType?: string
  pathname: string
}

export interface AgentDeliveryArtifactPublishResult {
  channelAttachmentId?: string
  url?: string
}

export type AgentDeliveryArtifactPublisher =
  (input: AgentDeliveryArtifactPublishInput) => MaybePromise<AgentDeliveryArtifactPublishResult>

export interface PublishWorkspaceArtifactsOptions {
  prefix?: string
  publish: AgentDeliveryArtifactPublisher
}

type GitHubAppValue<T, TRuntimeConfig extends AgentRuntimeConfig> =
  MaybeResolvable<T, AgentCallbackContext<TRuntimeConfig> | AgentChannelDeliveryEffectContext<TRuntimeConfig>>
type GitHubAppContext<TRuntimeConfig extends AgentRuntimeConfig> =
  AgentCallbackContext<TRuntimeConfig> | AgentChannelDeliveryEffectContext<TRuntimeConfig>

export interface GitHubAppOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  apiBaseUrl?: string
  appId?: GitHubAppValue<number | string | undefined, TRuntimeConfig>
  fetch?: typeof fetch
  installationId?: GitHubAppValue<number | string | undefined, TRuntimeConfig>
  privateKey?: GitHubAppValue<string | { unseal: () => string } | undefined, TRuntimeConfig>
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

export interface GitHubPullRequestRunContext {
  pullRequest: {
    apiUrl: string
    htmlUrl?: string
    labels?: string[]
    number: number
    source: {
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

export interface GitHubPullRequestCommentEventOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  ignored?: (reason: string) => Response
  origin?: string
  reply?: boolean | AgentChannelDeliveryFinishEffect
  sourceMount?: string
  sourceRef?: string
  threadId?: string
}

export interface GitHubChannelEventsOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  pullRequestComments?: boolean | GitHubPullRequestCommentEventOptions<TRuntimeConfig>
}

export interface GitHubChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentChannelOptions<TRuntimeConfig> {
  app?: true | GitHubAppOptions<TRuntimeConfig>
  events?: GitHubChannelEventsOptions<TRuntimeConfig>
}

interface GitHubPullRequestEffectsOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
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

function maybeStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return
  const strings = value.filter((item): item is string => typeof item === "string" && Boolean(item))
  return strings.length ? strings : undefined
}

function normalizeDeliveryArtifactPath(path: string, label: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/")
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`[vitehub] ${label} must stay inside the workspace: "${path}".`)
  }
  return normalized
}

function joinDeliveryArtifactPath(prefix: string | undefined, path: string): string {
  const cleanPrefix = prefix ? normalizeDeliveryArtifactPath(prefix, "Delivery artifact prefix") : undefined
  return cleanPrefix ? `${cleanPrefix}/${path}` : path
}

export async function publishWorkspaceArtifacts<TRuntimeConfig extends AgentRuntimeConfig>(
  context: Pick<AgentChannelDeliveryEffectContext<TRuntimeConfig>, "workspace">,
  artifacts: readonly AgentDeliveryArtifact[],
  options: PublishWorkspaceArtifactsOptions,
): Promise<PublishedAgentDeliveryArtifact[]> {
  if (!context.workspace) throw new Error("[vitehub] publishWorkspaceArtifacts() requires an Agent delivery context with a Workspace.")

  const published: PublishedAgentDeliveryArtifact[] = []
  for (const artifact of artifacts) {
    const path = normalizeDeliveryArtifactPath(artifact.path, "Delivery artifact path")
    const stat = await context.workspace.fs.stat(path).catch(() => undefined)
    const mediaType = artifact.mediaType || (stat?.type === "file" ? stat.mediaType : undefined)
    const content = await context.workspace.fs.readFile(path, { encoding: "binary" })
    const normalized = {
      ...artifact,
      path,
      ...(mediaType ? { mediaType } : {}),
    }
    published.push({
      ...normalized,
      ...await options.publish({
        artifact: normalized,
        content,
        ...(mediaType ? { mediaType } : {}),
        pathname: joinDeliveryArtifactPath(options.prefix, path),
      }),
    })
  }
  return published
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

type AgentChannelTriggerContextWithCapabilities<TRuntimeConfig extends AgentRuntimeConfig> =
  AgentCallbackContext<TRuntimeConfig> & {
    capabilities?: readonly AgentCapabilityDefinition<TRuntimeConfig>[]
    trigger?: { channelId?: string }
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
  context: AgentCallbackContext<TRuntimeConfig>,
  command: string,
): boolean | undefined {
  let sawMatchingTrigger = false
  const channelId = (context as AgentChannelTriggerContextWithCapabilities<TRuntimeConfig>).trigger?.channelId
  for (const capability of (context as AgentChannelTriggerContextWithCapabilities<TRuntimeConfig>).capabilities || []) {
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
  if (!payload || facts?.event !== "issue_comment" || payload.action !== "created") return
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
    ...(maybeNumber(facts?.installationId) ? { installationId: maybeNumber(facts?.installationId) } : {}),
    issueNumber,
    owner,
    pullRequestUrl,
    repo,
    repository,
  }
}

function githubPullRequestRunContext(
  command: GitHubPullRequestCommand,
  options: GitHubPullRequestCommentEventOptions = {},
  payload?: GitHubIssueCommentPayload,
): GitHubPullRequestRunContext {
  const runId = command.deliveryId || `github:${command.repository}#${command.issueNumber}:comment:${command.commentId}`
  const labels = maybeStrings(Array.isArray(payload?.issue?.labels)
    ? payload.issue.labels.map(label => isRecord(label) ? maybeString(label.name) : undefined)
    : undefined)
  return {
    pullRequest: {
      apiUrl: command.pullRequestUrl,
      ...(maybeString(payload?.issue?.pull_request?.html_url) || maybeString(payload?.issue?.html_url)
        ? { htmlUrl: maybeString(payload?.issue?.pull_request?.html_url) || maybeString(payload?.issue?.html_url) }
        : {}),
      ...(labels ? { labels } : {}),
      number: command.issueNumber,
      source: {
        mount: options.sourceMount || command.repo,
        ref: options.sourceRef || `refs/pull/${command.issueNumber}/head`,
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

const serverEnvModuleId = "#vitehub/env/server"

async function githubEnv(event?: unknown): Promise<Record<string, unknown>> {
  const fallback = typeof process === "object" && process?.env
    ? {
        appId: process.env.GITHUB_APP_ID,
        appInstallationId: process.env.GITHUB_APP_INSTALLATION_ID,
        appPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      }
    : {}
  try {
    const module = await import(/* @vite-ignore */ serverEnvModuleId) as { useServerEnv?: (event?: unknown) => unknown }
    const env = module.useServerEnv?.(event)
    return {
      ...fallback,
      ...(isRecord(env) && isRecord(env.github) ? env.github : {}),
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
  throw new Error("[vitehub] Missing GitHub App privateKey. github.appPrivateKey or GITHUB_APP_PRIVATE_KEY is required.")
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
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
) {
  const options = githubAppOptions(app) || {}
  const env = await githubEnv(context)
  const appId = requiredString(await githubAppSetting(options, env, "appId", "appId", context), "appId")
  const installationId = githubCommandFromEffect(context)?.installationId
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
  if (typeof context.effect.metadata?.body === "string") return context.effect.metadata.body
}

function deliveryArtifactFromUnknown(value: unknown): PublishedAgentDeliveryArtifact | undefined {
  if (!isRecord(value) || typeof value.path !== "string") return
  return {
    path: value.path,
    ...(typeof value.alt === "string" ? { alt: value.alt } : {}),
    ...(typeof value.channelAttachmentId === "string" ? { channelAttachmentId: value.channelAttachmentId } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    ...(value.placement === "inline" || value.placement === "attachment" || value.placement === "link" ? { placement: value.placement } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
  }
}

function deliveryArtifacts<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
): PublishedAgentDeliveryArtifact[] {
  const artifacts = [
    ...(Array.isArray(context.effect.artifacts) ? context.effect.artifacts : []),
    ...(isRecord(context.effect.payload) && Array.isArray(context.effect.payload.artifacts) ? context.effect.payload.artifacts : []),
  ]
  return artifacts.map(deliveryArtifactFromUnknown).filter((artifact): artifact is PublishedAgentDeliveryArtifact => Boolean(artifact))
}

function githubMarkdownText(value: string): string {
  return value.replace(/[\r\n\[\]]+/g, " ").trim() || "Artifact"
}

function githubMarkdownUrl(value: string): string {
  return value.replace(/[\r\n<>]+/g, "")
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

function githubBodyWithArtifacts<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentChannelDeliveryEffectContext<TRuntimeConfig>,
  body: string | undefined,
): string | undefined {
  const artifacts = deliveryArtifacts(context).map(githubArtifactMarkdown).filter((line): line is string => Boolean(line))
  if (!artifacts.length) return body
  return body ? `${body}\n\n${artifacts.join("\n")}` : artifacts.join("\n")
}

function finishResultText(result: unknown): string | undefined {
  if (typeof result === "string") return result
  if (result instanceof Response) return
  return isRecord(result) ? maybeString(result.text) : undefined
}

function finishUsageSummary(event: AgentFinishEvent): string | undefined {
  const usage = event.extensions.get("usage-telemetry")
  return isRecord(usage) ? maybeString(usage.summary) : undefined
}

function githubNote(body: string): string {
  return `> [!NOTE]\n${body.split("\n").map(line => `> ${line}`).join("\n")}`
}

function githubPullRequestCommentReplyEffect(event: AgentFinishEvent): AgentChannelDeliveryEffectIntent | undefined {
  const text = finishResultText(event.result)
  if (!text) return
  const body = text.trim() || "_No reply generated._"
  const summary = finishUsageSummary(event)
  return {
    kind: "reply",
    payload: summary ? `${body}\n\n${githubNote(summary)}` : body,
  }
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
      const body = githubBodyWithArtifacts(context, replyBody(context))
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
    async update(context) {
      const command = githubCommandFromEffect(context)
      const body = githubBodyWithArtifacts(context, replyBody(context))
      if (!command || !body) return
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/issues/comments/${command.commentId}`
      await githubApi(fetcher, url, {
        body: JSON.stringify({ body }),
        headers: githubApiHeaders(token, options.userAgent),
        method: "PATCH",
      })
    },
    async review(context) {
      const command = githubCommandFromEffect(context)
      const body = githubBodyWithArtifacts(context, replyBody(context))
      if (!command || !body) return
      const payload = isRecord(context.effect.payload) ? context.effect.payload : {}
      const fetcher = options.fetch || fetch
      const token = await resolveEffectOption(options.token, context)
      const url = `${options.apiBaseUrl || "https://api.github.com"}/repos/${command.owner}/${command.repo}/pulls/${command.issueNumber}/reviews`
      await githubApi(fetcher, url, {
        body: JSON.stringify({
          body,
          event: maybeString(payload.event) || maybeString(context.effect.metadata?.event) || "COMMENT",
        }),
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
  app?: true | GitHubAppOptions<TRuntimeConfig>,
): AgentChannelDefinition<TRuntimeConfig>["webhooks"] {
  const defaults = {
    secretHeader: "x-hub-signature-256",
    ...(app ? { secretToken: githubAppWebhookSecretToken(app) } : {}),
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

function ignored(reason: string) {
  return Response.json({ accepted: false, ok: true, reason })
}

function githubEventTriggers<TRuntimeConfig extends AgentRuntimeConfig>(
  events: GitHubChannelEventsOptions<TRuntimeConfig> | undefined,
): AgentChannelDefinition<TRuntimeConfig>["triggers"] {
  const pullRequestComments = events?.pullRequestComments
  if (!pullRequestComments) return undefined
  const options = pullRequestComments === true ? {} : pullRequestComments
  return {
    webhook: {
      async invoke(context, input): Promise<AgentTriggerInvokeResult> {
        const payload = inputPayloadOrBody(input)
        const command = githubPullRequestCommandFromInput(isRecord(input) ? { ...input, payload } : { payload })
        if (!payload && !command) return options.ignored?.("missing_payload") || ignored("missing_payload")
        if (!command) return options.ignored?.("not_command") || ignored("not_command")
        if (declaredInputCommand(context, command.command) === false) return options.ignored?.("not_command") || ignored("not_command")
        const pullRequest = githubPullRequestRunContext(command, {
          ...options,
          threadId: options.threadId || maybeString(payload?.issue?.pull_request?.html_url) || maybeString(payload?.issue?.html_url) || command.pullRequestUrl,
        }, payload)
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
  }
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
  options: GitHubChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  const { app: appOptions, events, ...channelOptions } = options
  const app = githubAppOptions(appOptions)
  const appEffects: AgentChannelDeliveryEffects<TRuntimeConfig> | undefined = appOptions
    ? githubPullRequestEffects<TRuntimeConfig>({
        apiBaseUrl: app?.apiBaseUrl,
        fetch: app?.fetch,
        statusContext: app?.statusContext,
        token: context => githubAppInstallationToken(appOptions, context),
        userAgent: app?.userAgent,
      })
    : undefined
  return defineChannel("github", {
    ...channelOptions,
    effects: appEffects ? { ...appEffects, ...options.effects } as AgentChannelDeliveryEffects<TRuntimeConfig> : options.effects,
    messages: false,
    triggers: {
      ...githubEventTriggers(events),
      ...options.triggers,
    },
    webhooks: githubWebhookDefaults(options.webhooks, appOptions),
  })
}

export function http<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
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
