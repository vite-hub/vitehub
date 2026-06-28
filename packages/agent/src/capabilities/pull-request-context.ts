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

export interface PullRequestContextValue {
  actor?: string
  baseRef?: string
  deliveryId?: string
  headRef?: string
  id?: number | string
  number: number | string
  provider?: string
  repository: string
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
const defaultSourcePath = "context.md"
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

function frontmatterValue(value: number | string): string {
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

function normalizePullRequestContext(value: unknown): PullRequestContextValue | undefined {
  if (!isRecord(value)) return

  const flatNumber = maybeContextValue(value.number)
  const flatRepository = maybeString(value.repository)
  if (flatNumber !== undefined && flatRepository) {
    return {
      ...(maybeString(value.actor) ? { actor: maybeString(value.actor) } : {}),
      ...(maybeString(value.baseRef) ? { baseRef: maybeString(value.baseRef) } : {}),
      ...(maybeString(value.deliveryId) ? { deliveryId: maybeString(value.deliveryId) } : {}),
      ...(maybeString(value.headRef) ? { headRef: maybeString(value.headRef) } : {}),
      ...(maybeContextValue(value.id) !== undefined ? { id: maybeContextValue(value.id) } : {}),
      number: flatNumber,
      ...(maybeString(value.provider) ? { provider: maybeString(value.provider) } : {}),
      repository: flatRepository,
    }
  }

  const pullRequest = isRecord(value.pullRequest) ? value.pullRequest : undefined
  const repository = isRecord(value.repository) ? value.repository : undefined
  const trigger = isRecord(value.trigger) ? value.trigger : undefined
  const actor = isRecord(trigger?.actor) ? trigger.actor : undefined
  const source = isRecord(pullRequest?.source) ? pullRequest.source : undefined
  const number = maybeContextValue(pullRequest?.number)
  const repositoryName = maybeString(repository?.fullName)
  if (number === undefined || !repositoryName) return
  const actorLogin = actor ? maybeString(actor.login) : undefined
  const deliveryId = trigger ? maybeString(trigger.deliveryId) : undefined
  const headRef = source ? maybeString(source.ref) : undefined

  return {
    ...(actorLogin ? { actor: actorLogin } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(headRef ? { headRef } : {}),
    number,
    provider: "github",
    repository: repositoryName,
  }
}

function renderPullRequestContextMarkdown(input: unknown): string {
  const value = normalizePullRequestContext(input)
  const frontmatter = ([
    ["repository", value?.repository],
    ["number", value?.number],
    ["id", value?.id],
    ["provider", value?.provider],
    ["baseRef", value?.baseRef],
    ["headRef", value?.headRef],
    ["actor", value?.actor],
    ["deliveryId", value?.deliveryId],
  ] as const)
    .flatMap(([key, item]) => item === undefined ? [] : `${key}: ${frontmatterValue(item)}`)
    .join("\n")
  const body = value
    ? `# Pull Request Context\n\nChange Request ${value.number} in ${value.repository}.`
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
    probeKeys: [defaultSourcePath],
    async getKeys() {
      return [defaultSourcePath]
    },
    async getItem(key) {
      if (key !== defaultSourcePath) {
        throw new Error(`[vitehub] Workspace file does not exist: ${mount}/${key}.`)
      }
      return {
        content: renderPullRequestContextMarkdown(context.get(contextKey)),
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

export function pullRequestContext<
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
      context.context.set(contextKey, value)
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
      grantSelectedWorkspaceScopePath(context.context, [source.mount, defaultSourcePath].join("/"))
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
