import { createSign } from "node:crypto"
import { readFile } from "node:fs/promises"

import type {
  AgentCallbackContext,
  AgentChannelDefinition,
  AgentChannelDeliveryEffectContext,
  AgentChannelDeliveryEffects,
  AgentChannelTriggerContext,
  AgentChatWebhookRegistrationDefinition,
  AgentMessageChannelSettings,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentTriggerInvokeResult,
  AgentWebhookSecretToken,
  MaybePromise,
  MaybeResolvable,
} from "./types.ts"
import type { AgentChatFetchHandlerOptions } from "./server.ts"

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
  privateKeyPath?: GitHubAppValue<string | undefined, TRuntimeConfig>
  statusContext?: string
  userAgent?: string
  webhookSecret?: GitHubAppValue<false | string | { unseal: () => string } | undefined, TRuntimeConfig>
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
  command: string
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

export interface GitHubPullRequestCommandOptions {
  command: `/${string}` | (string & {})
}

export interface GitHubPullRequestCommandInvokeContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> {
  command: GitHubPullRequestCommand
  input: unknown
  payload: GitHubIssueCommentPayload
  pullRequest: GitHubPullRequestRunContext
  run: AgentRunMetadata
  trigger: AgentChannelTriggerContext<TRuntimeConfig>
}

export interface GitHubPullRequestCommandTriggerOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> extends GitHubPullRequestCommandOptions {
  authorize?: (context: GitHubPullRequestCommandInvokeContext<TRuntimeConfig>) => MaybePromise<boolean | Response>
  ignored?: (reason: string, context?: GitHubPullRequestCommandInvokeContext<TRuntimeConfig>) => Response
  invoke: (context: GitHubPullRequestCommandInvokeContext<TRuntimeConfig>) => MaybePromise<AgentTriggerInvokeResult<CALL_OPTIONS>>
  origin?: string
}

export interface GitHubChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentChannelOptions<TRuntimeConfig> {
  app?: true | GitHubAppOptions<TRuntimeConfig>
  commands?: Record<string, GitHubPullRequestCommandTriggerOptions<TRuntimeConfig>>
}

export interface GitHubPullRequestRunContextOptions {
  origin?: string
  runId?: string
  sourceMount?: string
  sourceRef?: string
  threadId?: string
}

export interface GitHubPullRequestRunContext {
  pullRequest: {
    apiUrl: string
    number: number
    source: {
      mount: string
      ref: string
      repo: string
    }
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
      id: number
      nodeId?: string
    }
    deliveryId?: string
    installationId?: number
  }
}

interface GitHubPullRequestEffectsOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  apiBaseUrl?: string
  fetch?: typeof fetch
  statusContext?: string
  token: MaybeResolvable<string, AgentChannelDeliveryEffectContext<TRuntimeConfig>>
  userAgent?: string
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

function matchCommand(body: string, command: string): string | undefined {
  const text = body.trim()
  if (text === command) return ""
  if (text.startsWith(`${command} `) || text.startsWith(`${command}\n`)) return text.slice(command.length).trim()
  return undefined
}

export function githubPullRequestCommand(input: unknown, options: GitHubPullRequestCommandOptions): GitHubPullRequestCommand | undefined {
  const command = options.command.trim()
  if (!command.startsWith("/")) {
    throw new TypeError("[vitehub] githubPullRequestCommand({ command }) requires slash command text such as \"/review\".")
  }
  const payload = inputPayload(input)
  const facts = inputGithubFacts(input)
  if (!payload || facts?.event !== "issue_comment" || payload.action !== "created") return
  if (!payload.issue?.pull_request) return
  const body = maybeString(payload.comment?.body)
  if (!body) return
  const args = matchCommand(body, command)
  if (args === undefined) return
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
    args,
    command,
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

export function githubPullRequestRunContext(
  command: GitHubPullRequestCommand,
  options: GitHubPullRequestRunContextOptions = {},
): GitHubPullRequestRunContext {
  const runId = options.runId || command.deliveryId || `github:${command.repository}#${command.issueNumber}:comment:${command.commentId}`
  return {
    pullRequest: {
      apiUrl: command.pullRequestUrl,
      number: command.issueNumber,
      source: {
        mount: options.sourceMount || command.repo,
        ref: options.sourceRef || `refs/pull/${command.issueNumber}/head`,
        repo: command.repository,
      },
    },
    repository: {
      fullName: command.repository,
      name: command.repo,
      owner: command.owner,
    },
    run: {
      messageId: String(command.commentId),
      origin: options.origin || "github-pull-request",
      runId,
      threadId: options.threadId || command.pullRequestUrl,
    },
    trigger: {
      action: command.action,
      actor: command.actor,
      args: command.args,
      command: command.command,
      comment: {
        id: command.commentId,
        ...(command.commentNodeId ? { nodeId: command.commentNodeId } : {}),
      },
      ...(command.deliveryId ? { deliveryId: command.deliveryId } : {}),
      ...(command.installationId ? { installationId: command.installationId } : {}),
    },
  }
}

function ignored(reason: string) {
  return Response.json({ accepted: false, ok: true, reason })
}

function withGithubCommandInput(input: unknown, payload: GitHubIssueCommentPayload): unknown {
  return isRecord(input) ? { ...input, payload } : { payload }
}

function githubPullRequestCommandInvocation<TRuntimeConfig extends AgentRuntimeConfig>(
  result: AgentTriggerInvokeResult,
  channelId: string,
  command: GitHubPullRequestCommand,
  pullRequest: GitHubPullRequestRunContext,
): AgentTriggerInvokeResult {
  if (result instanceof Response) return result
  return {
    ...result,
    input: {
      ...result.input,
      context: {
        ...result.input.context,
        github: command,
        pullRequest,
      },
    },
    run: {
      ...pullRequest.run,
      channelId,
      ...result.run,
    },
  }
}

function githubPullRequestCommandTrigger<TRuntimeConfig extends AgentRuntimeConfig>(
  commands: Record<string, GitHubPullRequestCommandTriggerOptions<TRuntimeConfig>>,
  dev?: AgentChannelDefinition<TRuntimeConfig>["dev"],
): NonNullable<AgentChannelDefinition<TRuntimeConfig>["triggers"]>[string] {
  return {
    ...(dev ? { dev } : {}),
    async invoke(context, input) {
      const payload = inputPayloadOrBody(input)
      if (!payload) return ignored("missing_payload")
      for (const options of Object.values(commands)) {
        const command = githubPullRequestCommand(withGithubCommandInput(input, payload), options)
        if (!command) continue
        const pullRequest = githubPullRequestRunContext(command, {
          origin: options.origin,
          threadId: maybeString(payload.issue?.pull_request?.html_url) || maybeString(payload.issue?.html_url),
        })
        const commandContext = {
          command,
          input,
          payload,
          pullRequest,
          run: {
            ...pullRequest.run,
            channelId: context.trigger.channelId,
          },
          trigger: context,
        } satisfies GitHubPullRequestCommandInvokeContext<TRuntimeConfig>
        const authorized = await options.authorize?.(commandContext)
        if (authorized instanceof Response) return authorized
        if (authorized === false) return options.ignored?.("unauthorized", commandContext) || ignored("unauthorized")
        return githubPullRequestCommandInvocation(
          await options.invoke(commandContext),
          context.trigger.channelId,
          command,
          pullRequest,
        )
      }
      return ignored("not_command")
    },
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
        appPrivateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
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
  const path = cleanSecret(await githubAppSetting(options, env, "privateKeyPath", "appPrivateKeyPath", context))
  if (path) return await readFile(path, "utf8")
  throw new Error("[vitehub] Missing GitHub App privateKey. Set github.appPrivateKey, github.appPrivateKeyPath, GITHUB_APP_PRIVATE_KEY, or GITHUB_APP_PRIVATE_KEY_PATH.")
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
  options: GitHubChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  if (options.commands && options.triggers?.webhook) {
    throw new TypeError("[vitehub] github({ commands }) owns the webhook trigger. Use commands or triggers.webhook, not both.")
  }
  const app = githubAppOptions(options.app)
  const appEffects: AgentChannelDeliveryEffects<TRuntimeConfig> | undefined = options.app
    ? githubPullRequestEffects<TRuntimeConfig>({
        apiBaseUrl: app?.apiBaseUrl,
        fetch: app?.fetch,
        statusContext: app?.statusContext,
        token: context => githubAppInstallationToken(options.app!, context),
        userAgent: app?.userAgent,
      })
    : undefined
  return defineChannel("github", {
    ...options,
    effects: appEffects ? { ...appEffects, ...options.effects } as AgentChannelDeliveryEffects<TRuntimeConfig> : options.effects,
    messages: false,
    triggers: options.commands
      ? { ...options.triggers, webhook: githubPullRequestCommandTrigger(options.commands, options.dev) }
      : options.triggers,
    webhooks: githubWebhookDefaults(options.webhooks, options.app),
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
