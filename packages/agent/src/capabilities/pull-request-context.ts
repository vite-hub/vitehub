import { hasTrustedWorkspaceAccessScope } from "../access-runtime.ts"
import { defineCapability, optionalWorkspaceCapabilitySymbol } from "../capability-runtime.ts"

import type {
  AgentInvocationContextStore,
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentCapabilityWorkspaceContribution,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
  MaybePromise,
} from "../types.ts"
import type {
  WorkspaceSource,
  WorkspaceName,
  WorkspaceRules,
  WorkspaceSourceInput,
} from "@vite-hub/workspace"

export interface PullRequestContextUser {
  id?: number | string
  login?: string
  type?: string
}

export interface PullRequestContextComment {
  authorAssociation?: string
  body?: string
  createdAt?: string
  htmlUrl?: string
  id?: number | string
  nodeId?: string
  updatedAt?: string
  user?: PullRequestContextUser
}

export interface PullRequestContextFile {
  additions?: number | string
  deletions?: number | string
  filename?: string
  status?: string
}

export interface PullRequestContextRef {
  ref?: string
  repo?: string
  sha?: string
}

export interface PullRequestContextMetadata {
  omittedComments?: number | string
  omittedFiles?: number | string
  unavailable?: string
}

export interface PullRequestContextValue {
  actor?: string
  apiUrl?: string
  base?: PullRequestContextRef
  baseRef?: string
  body?: string
  comments?: PullRequestContextComment[]
  deliveryId?: string
  files?: PullRequestContextFile[]
  head?: PullRequestContextRef
  headRef?: string
  htmlUrl?: string
  id?: number | string
  labels?: string[]
  metadata?: PullRequestContextMetadata
  number: number | string
  provider?: string
  repository: string
  run?: {
    messageId?: string
    origin?: string
    runId?: string
    threadId?: string
  }
  source?: {
    mount?: string
    ref?: string
    repo?: string
  }
  title?: string
  trigger?: {
    action?: string
    actor?: PullRequestContextUser
    args?: string
    command?: string
    comment?: PullRequestContextComment
    deliveryId?: string
    event?: string
    installationId?: number | string
    sender?: PullRequestContextUser
  }
}

export type PullRequestContextResolver<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<PullRequestContextValue | false | null | undefined>

export type PullRequestContextSources<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | Record<string, WorkspaceSourceInput>
  | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<Record<string, WorkspaceSourceInput> | false | null | undefined>)

export type PullRequestContextRules<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | WorkspaceRules
  | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<WorkspaceRules | false | null | undefined>)

export interface PullRequestContextOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  context?: PullRequestContextValue | PullRequestContextResolver<TRuntimeConfig, Name>
  contextKey?: string
  id?: string
  rules?: PullRequestContextRules<TRuntimeConfig, Name>
  sources?: PullRequestContextSources<TRuntimeConfig, Name>
  triggers?: Record<string, AgentTriggerDefinition<TRuntimeConfig, Name, any, any>>
}

type PullRequestContextCapabilityTypeContract<
  TContextKey extends string = "pullRequest",
> = AgentCapabilityTypeContract & {
  invocationContext: Record<TContextKey, PullRequestContextValue>
}

const defaultSourceKey = "pullRequestContext"
const defaultSourceMount = "pull-request-context"
const defaultMarkdownSourcePath = "context.md"
const defaultJsonSourcePath = "context.json"
const defaultCapabilityId = "pull-request-context"

async function resolveMaybeFunction<TValue, TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  value: TValue | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<TValue | false | null | undefined>) | undefined,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): Promise<TValue | undefined> {
  const resolved = typeof value === "function"
    ? await (value as (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<TValue | false | null | undefined>)(context)
    : value
  return resolved || undefined
}

function frontmatterValue(value: unknown): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function maybeContextValue(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined
}

function maybeStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return
  const items = value.filter((item): item is string => typeof item === "string" && !!item)
  return items.length ? items : undefined
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

function normalizedRef(value: unknown): PullRequestContextRef | undefined {
  if (!isRecord(value)) return
  const ref = maybeString(value.ref)
  const repo = maybeString(value.repo)
  const sha = maybeString(value.sha)
  if (!ref && !repo && !sha) return
  return {
    ...(ref ? { ref } : {}),
    ...(repo ? { repo } : {}),
    ...(sha ? { sha } : {}),
  }
}

function normalizedFlatRef(value: unknown, fallbackRef: string | undefined): PullRequestContextRef | undefined {
  return normalizedRef(value) || (fallbackRef ? { ref: fallbackRef } : undefined)
}

function normalizedUser(value: unknown): PullRequestContextUser | undefined {
  if (!isRecord(value)) return
  const id = maybeContextValue(value.id)
  const login = maybeString(value.login)
  const type = maybeString(value.type)
  if (id === undefined && !login && !type) return
  return {
    ...(id !== undefined ? { id } : {}),
    ...(login ? { login } : {}),
    ...(type ? { type } : {}),
  }
}

function normalizedComment(value: unknown): PullRequestContextComment | undefined {
  if (!isRecord(value)) return
  const id = maybeContextValue(value.id)
  const body = maybeString(value.body)
  const user = normalizedUser(value.user)
  if (id === undefined && !body && !user) return
  return {
    ...(maybeString(value.authorAssociation) ? { authorAssociation: maybeString(value.authorAssociation) } : {}),
    ...(body ? { body } : {}),
    ...(maybeString(value.createdAt) ? { createdAt: maybeString(value.createdAt) } : {}),
    ...(maybeString(value.htmlUrl) ? { htmlUrl: maybeString(value.htmlUrl) } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(maybeString(value.nodeId) ? { nodeId: maybeString(value.nodeId) } : {}),
    ...(maybeString(value.updatedAt) ? { updatedAt: maybeString(value.updatedAt) } : {}),
    ...(user ? { user } : {}),
  }
}

function normalizedFile(value: unknown): PullRequestContextFile | undefined {
  if (!isRecord(value)) return
  const filename = maybeString(value.filename)
  if (!filename) return
  return {
    ...(maybeContextValue(value.additions) !== undefined ? { additions: maybeContextValue(value.additions) } : {}),
    ...(maybeContextValue(value.deletions) !== undefined ? { deletions: maybeContextValue(value.deletions) } : {}),
    filename,
    ...(maybeString(value.status) ? { status: maybeString(value.status) } : {}),
  }
}

function normalizedMetadata(value: unknown): PullRequestContextMetadata | undefined {
  if (!isRecord(value)) return
  const omittedComments = maybeContextValue(value.omittedComments)
  const omittedFiles = maybeContextValue(value.omittedFiles)
  const unavailable = maybeString(value.unavailable)
  if (omittedComments === undefined && omittedFiles === undefined && !unavailable) return
  return {
    ...(omittedComments !== undefined ? { omittedComments } : {}),
    ...(omittedFiles !== undefined ? { omittedFiles } : {}),
    ...(unavailable ? { unavailable } : {}),
  }
}

function normalizedRun(value: unknown): PullRequestContextValue["run"] | undefined {
  if (!isRecord(value)) return
  const messageId = maybeString(value.messageId)
  const origin = maybeString(value.origin)
  const runId = maybeString(value.runId)
  const threadId = maybeString(value.threadId)
  if (!messageId && !origin && !runId && !threadId) return
  return {
    ...(messageId ? { messageId } : {}),
    ...(origin ? { origin } : {}),
    ...(runId ? { runId } : {}),
    ...(threadId ? { threadId } : {}),
  }
}

function normalizedSource(value: unknown): PullRequestContextValue["source"] | undefined {
  if (!isRecord(value)) return
  const mount = maybeString(value.mount)
  const ref = maybeString(value.ref)
  const repo = maybeString(value.repo)
  if (!mount && !ref && !repo) return
  return {
    ...(mount ? { mount } : {}),
    ...(ref ? { ref } : {}),
    ...(repo ? { repo } : {}),
  }
}

function normalizedTrigger(value: unknown): PullRequestContextValue["trigger"] | undefined {
  if (!isRecord(value)) return
  const action = maybeString(value.action)
  const actor = normalizedUser(value.actor)
  const args = maybeString(value.args)
  const command = maybeString(value.command)
  const comment = normalizedComment(value.comment)
  const deliveryId = maybeString(value.deliveryId)
  const event = maybeString(value.event)
  const installationId = maybeContextValue(value.installationId)
  const sender = normalizedUser(value.sender)
  if (!action && !actor && !args && !command && !comment && !deliveryId && !event && installationId === undefined && !sender) return
  return {
    ...(action ? { action } : {}),
    ...(actor ? { actor } : {}),
    ...(args ? { args } : {}),
    ...(command ? { command } : {}),
    ...(comment ? { comment } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(event ? { event } : {}),
    ...(installationId !== undefined ? { installationId } : {}),
    ...(sender ? { sender } : {}),
  }
}

function normalizedRepositoryFullName(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value
  return isRecord(value) ? maybeString(value.fullName) : undefined
}

function normalizePullRequestContext(value: unknown): PullRequestContextValue | undefined {
  if (!isRecord(value)) return

  const flatNumber = maybeContextValue(value.number)
  const flatRepository = normalizedRepositoryFullName(value.repository)
  if (flatNumber !== undefined && flatRepository) {
    const base = normalizedFlatRef(value.base, maybeString(value.baseRef))
    const comments = Array.isArray(value.comments) ? value.comments.map(normalizedComment).filter(isPresent) : undefined
    const files = Array.isArray(value.files) ? value.files.map(normalizedFile).filter(isPresent) : undefined
    const head = normalizedFlatRef(value.head, maybeString(value.headRef))
    const labels = maybeStrings(value.labels)
    const metadata = normalizedMetadata(value.metadata)
    const run = normalizedRun(value.run)
    const source = normalizedSource(value.source)
    const trigger = {
      ...(normalizedTrigger(value.trigger) || {}),
      ...(maybeString(value.actor) ? { actor: { login: maybeString(value.actor) } } : {}),
      ...(maybeString(value.deliveryId) ? { deliveryId: maybeString(value.deliveryId) } : {}),
    }
    const actor = trigger.actor?.login
    const deliveryId = trigger.deliveryId
    return {
      ...(actor ? { actor } : {}),
      ...(maybeString(value.apiUrl) ? { apiUrl: maybeString(value.apiUrl) } : {}),
      ...(base ? { base } : {}),
      ...(base?.ref ? { baseRef: base.ref } : {}),
      ...(maybeString(value.body) ? { body: maybeString(value.body) } : {}),
      ...(comments?.length ? { comments } : {}),
      ...(deliveryId ? { deliveryId } : {}),
      ...(files?.length ? { files } : {}),
      ...(head ? { head } : {}),
      ...(head?.ref ? { headRef: head.ref } : {}),
      ...(maybeString(value.htmlUrl) ? { htmlUrl: maybeString(value.htmlUrl) } : {}),
      ...(maybeContextValue(value.id) !== undefined ? { id: maybeContextValue(value.id) } : {}),
      ...(labels ? { labels } : {}),
      ...(metadata ? { metadata } : {}),
      number: flatNumber,
      ...(maybeString(value.provider) ? { provider: maybeString(value.provider) } : {}),
      repository: flatRepository,
      ...(run ? { run } : {}),
      ...(source ? { source } : {}),
      ...(maybeString(value.title) ? { title: maybeString(value.title) } : {}),
      ...(Object.keys(trigger).length ? { trigger } : {}),
    }
  }

  const pullRequest = isRecord(value.pullRequest) ? value.pullRequest : undefined
  const repository = isRecord(value.repository) ? value.repository : undefined
  const number = maybeContextValue(pullRequest?.number)
  const repositoryName = maybeString(repository?.fullName)
  if (!pullRequest || number === undefined || !repositoryName) return
  const comments = Array.isArray(pullRequest.comments) ? pullRequest.comments.map(normalizedComment).filter(isPresent) : undefined
  const files = Array.isArray(pullRequest.files) ? pullRequest.files.map(normalizedFile).filter(isPresent) : undefined
  const labels = maybeStrings(pullRequest.labels)
  const metadata = normalizedMetadata(pullRequest.metadata)
  const base = normalizedRef(pullRequest.base)
  const head = normalizedRef(pullRequest.head)
  const source = normalizedSource(pullRequest.source)
  const trigger = normalizedTrigger(value.trigger)
  const actor = trigger?.actor?.login
  const deliveryId = trigger?.deliveryId

  return {
    ...(actor ? { actor } : {}),
    ...(maybeString(pullRequest.apiUrl) ? { apiUrl: maybeString(pullRequest.apiUrl) } : {}),
    ...(base ? { base } : {}),
    ...(base?.ref ? { baseRef: base.ref } : {}),
    ...(maybeString(pullRequest.body) ? { body: maybeString(pullRequest.body) } : {}),
    ...(comments?.length ? { comments } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(files?.length ? { files } : {}),
    ...(head ? { head } : {}),
    ...(source?.ref || head?.ref ? { headRef: source?.ref || head?.ref } : {}),
    ...(maybeString(pullRequest.htmlUrl) ? { htmlUrl: maybeString(pullRequest.htmlUrl) } : {}),
    ...(maybeContextValue(pullRequest.id) !== undefined ? { id: maybeContextValue(pullRequest.id) } : {}),
    ...(labels ? { labels } : {}),
    ...(metadata ? { metadata } : {}),
    number,
    provider: maybeString(value.provider) || "github",
    repository: repositoryName,
    ...(normalizedRun(value.run) ? { run: normalizedRun(value.run) } : {}),
    ...(source ? { source } : {}),
    ...(maybeString(pullRequest.title) ? { title: maybeString(pullRequest.title) } : {}),
    ...(trigger ? { trigger } : {}),
  }
}

function readPullRequestContext(context: unknown, contextKey = "pullRequest"): PullRequestContextValue | undefined {
  if (isRecord(context) && isRecord(context.context) && typeof context.context.get === "function") {
    return normalizePullRequestContext(context.context.get(contextKey))
  }
  if (isRecord(context) && typeof context.get === "function") return normalizePullRequestContext(context.get(contextKey))
  return normalizePullRequestContext(context)
}

function renderList(items: string[]): string {
  return items.length ? items.map(item => `- ${item}`).join("\n") : "- None recorded."
}

function renderPullRequestDetails(value: PullRequestContextValue | undefined): string {
  if (!value) return ""
  const lines: string[] = []

  if (value.metadata?.unavailable) {
    lines.push(`PR metadata unavailable: ${value.metadata.unavailable}`)
  }

  const branchLines = [
    ...(value.base?.ref || value.base?.sha ? [`Base: ${[value.base.ref, value.base.sha].filter(Boolean).join(" @ ")}`] : []),
    ...(value.head?.ref || value.head?.sha || value.source?.ref ? [`Head: ${[value.source?.ref || value.head?.ref, value.head?.sha].filter(Boolean).join(" @ ")}`] : []),
  ]
  if (branchLines.length) {
    lines.push("## Branches")
    lines.push(renderList(branchLines))
  }

  if (value.title) {
    lines.push("## Title", value.title)
  }

  if (value.body) {
    lines.push("## Body", value.body)
  }

  if (value.files?.length || value.metadata?.omittedFiles) {
    lines.push("## Changed Files")
    if (value.files?.length) lines.push(renderList(value.files.map((file) => {
      const filename = file.filename || "unknown"
      const status = file.status
      const additions = file.additions
      const deletions = file.deletions
      const counts = additions !== undefined || deletions !== undefined ? ` (+${additions ?? 0}/-${deletions ?? 0})` : ""
      return `${filename}${status ? ` (${status})` : ""}${counts}`
    })))
    if (value.metadata?.omittedFiles) lines.push(`+${value.metadata.omittedFiles} more files not shown.`)
  }

  const comments = [
    ...(value.comments || []),
    ...(value.trigger?.comment ? [value.trigger.comment] : []),
  ]
  if (comments.length || value.metadata?.omittedComments) {
    const commentLines = comments.map(comment => `${comment.user?.login || "unknown"}: ${comment.body || "(no body)"}`)
    if (value.metadata?.omittedComments) commentLines.push(`+${value.metadata.omittedComments} more comments not shown.`)
    lines.push("## Comments (untrusted user content)")
    lines.push(renderList(commentLines))
  }

  return lines.length ? `\n\n${lines.join("\n\n")}` : ""
}

function renderPullRequestContextMarkdown(input: unknown): string {
  const value = normalizePullRequestContext(input)
  const frontmatter = ([
    ["repository", value?.repository],
    ["number", value?.number],
    ["id", value?.id],
    ["provider", value?.provider],
    ["source", value?.source],
    ["base", value?.base],
    ["head", value?.head],
    ["deliveryId", value?.trigger?.deliveryId],
  ] as const)
    .flatMap(([key, item]) => item === undefined ? [] : `${key}: ${frontmatterValue(item)}`)
    .join("\n")
  const body = value
    ? `# Pull Request Context\n\nChange Request ${value.number} in ${value.repository}.${renderPullRequestDetails(value)}`
    : "# Pull Request Context\n\nNo pull request context was recorded for this Agent Invocation."
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

function pullRequestContextSource(
  context: AgentInvocationContextStore,
  contextKey: string,
  mount: string,
): WorkspaceSource {
  return {
    materialize: "lazy",
    mount,
    probeKeys: [defaultMarkdownSourcePath, defaultJsonSourcePath],
    async getKeys() {
      return [defaultMarkdownSourcePath, defaultJsonSourcePath]
    },
    async getItem(key) {
      if (key !== defaultMarkdownSourcePath && key !== defaultJsonSourcePath) {
        throw new Error(`[vitehub] Workspace file does not exist: ${mount}/${key}.`)
      }
      const value = readPullRequestContext(context, contextKey)
      if (key === defaultJsonSourcePath) {
        return {
          content: `${JSON.stringify(value || null, null, 2)}\n`,
          key,
          mediaType: "application/json",
        }
      }
      return {
        content: renderPullRequestContextMarkdown(value),
        key,
        mediaType: "text/markdown",
      }
    },
  }
}

function grantSelectedWorkspaceScopePath(context: AgentInvocationContextStore, path: string): void {
  if (!hasTrustedWorkspaceAccessScope(context)) return
  const access = context.get<{ workspaceScope?: { all?: boolean, paths?: readonly string[], role?: string, scope?: string } }>("access")
  const scope = access?.workspaceScope
  if (!scope || scope.all) return
  const paths = scope.paths || []
  if (paths.includes(path)) return
  context.set("access", {
    ...access,
    workspaceScope: {
      ...scope,
      paths: [...paths, path],
    },
  }, { overwrite: true })
}

function defaultSourceIdentity(capabilityId: string) {
  return capabilityId === defaultCapabilityId
    ? { key: defaultSourceKey, mount: defaultSourceMount }
    : { key: `${capabilityId}-context`, mount: capabilityId }
}

export interface PullRequestContextCapabilityFactory {
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
    const TSourceMap extends Record<string, WorkspaceSourceInput> | undefined = undefined,
    const TContextKey extends string = "pullRequest",
  >(
    options?: PullRequestContextOptions<TRuntimeConfig, Name> & { contextKey?: TContextKey, sources?: TSourceMap | PullRequestContextSources<TRuntimeConfig, Name> },
  ): AgentCapabilityDefinition<TRuntimeConfig, Name, PullRequestContextCapabilityTypeContract<TContextKey>>
  read(input: unknown, contextKey?: string): PullRequestContextValue | undefined
}

function createPullRequestContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  const TSourceMap extends Record<string, WorkspaceSourceInput> | undefined = undefined,
  const TContextKey extends string = "pullRequest",
>(
  options: PullRequestContextOptions<TRuntimeConfig, Name> & { contextKey?: TContextKey, sources?: TSourceMap | PullRequestContextSources<TRuntimeConfig, Name> } = {},
): AgentCapabilityDefinition<TRuntimeConfig, Name, PullRequestContextCapabilityTypeContract<TContextKey>> {
  const capabilityId = options.id || defaultCapabilityId
  const contextKey = options.contextKey || "pullRequest"
  const source = defaultSourceIdentity(capabilityId)
  const hasCustomWorkspaceContribution = options.sources !== undefined || options.rules !== undefined
  const recordedContexts = new WeakSet<AgentCapabilityContext<TRuntimeConfig, Name>["context"]>()

  async function recordContext(context: AgentCapabilityContext<TRuntimeConfig, Name>) {
    if (recordedContexts.has(context.context)) return
    const value = await resolveMaybeFunction(options.context, context)
    if (value !== undefined) {
      context.context.set(contextKey, normalizePullRequestContext(value) || value)
      recordedContexts.add(context.context)
    }
  }

  return defineCapability({
    id: capabilityId,
    metadata: {
      contextKey,
      kind: "pull-request-context",
      [optionalWorkspaceCapabilitySymbol]: !hasCustomWorkspaceContribution,
    },
    prepare: recordContext,
    triggers: options.triggers,
    workspace: async (context): Promise<AgentCapabilityWorkspaceContribution | undefined> => {
      await recordContext(context)
      const sources = await resolveMaybeFunction(options.sources, context)
      const rules = await resolveMaybeFunction(options.rules, context)
      if (sources && Object.hasOwn(sources, source.key)) {
        throw new Error(`[vitehub] ${capabilityId}() sources cannot use reserved Workspace Source key "${source.key}".`)
      }
      grantSelectedWorkspaceScopePath(context.context, source.mount)
      return {
        ...(rules ? { rules } : {}),
        sources: {
          [source.key]: pullRequestContextSource(context.context, contextKey, source.mount),
          ...(sources || {}),
        },
      }
    },
  })
}

export const pullRequestContext = Object.assign(createPullRequestContext, {
  read: readPullRequestContext,
}) as PullRequestContextCapabilityFactory
