import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentRuntimeConfig,
  AgentTriggerContext,
  AgentTriggerDefinition,
  AgentTriggerInvokeResult,
  AgentRunMetadata,
  MaybePromise,
} from "../types.ts"

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
  trigger: AgentTriggerContext<TRuntimeConfig>
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

export interface GitHubPullRequestCommandsOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> {
  commands: Record<string, GitHubPullRequestCommandTriggerOptions<TRuntimeConfig>>
  dev?: AgentTriggerDefinition<TRuntimeConfig>["dev"]
  id?: string
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

function inputWebhookChannelId(input: unknown): string | undefined {
  if (!isRecord(input) || !isRecord(input.webhook)) return
  return maybeString(input.webhook.channelId)
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

function githubPullRequestCommandInvocation(
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

export function githubCommandFromUnknown(value: unknown): GitHubPullRequestCommand | undefined {
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

export function githubPullRequestCommands<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: GitHubPullRequestCommandsOptions<TRuntimeConfig>,
): AgentCapabilityDefinition<TRuntimeConfig> {
  const commands = options.commands
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    throw new TypeError("[vitehub] githubPullRequestCommands({ commands }) requires a command map.")
  }
  return defineCapability({
    id: options.id || "github",
    triggers: {
      webhook: {
        ...(options.dev ? { dev: options.dev } : {}),
        async invoke(context, input) {
          const payload = inputPayloadOrBody(input)
          if (!payload) return ignored("missing_payload")
          for (const commandOptions of Object.values(commands)) {
            const command = githubPullRequestCommand(withGithubCommandInput(input, payload), commandOptions)
            if (!command) continue
            const pullRequest = githubPullRequestRunContext(command, {
              origin: commandOptions.origin,
              threadId: maybeString(payload.issue?.pull_request?.html_url) || maybeString(payload.issue?.html_url),
            })
            const channelId = inputWebhookChannelId(input) || context.trigger.capabilityId
            const commandContext = {
              command,
              input,
              payload,
              pullRequest,
              run: {
                ...pullRequest.run,
                channelId,
              },
              trigger: context,
            } satisfies GitHubPullRequestCommandInvokeContext<TRuntimeConfig>
            const authorized = await commandOptions.authorize?.(commandContext)
            if (authorized instanceof Response) return authorized
            if (authorized === false) return commandOptions.ignored?.("unauthorized", commandContext) || ignored("unauthorized")
            return githubPullRequestCommandInvocation(
              await commandOptions.invoke(commandContext),
              channelId,
              command,
              pullRequest,
            )
          }
          return ignored("not_command")
        },
      },
    },
  })
}
