import { defineCapability } from "../capability-runtime.ts"

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
const defaultSourcePath = "context.md"

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

function renderPullRequestContextMarkdown(value: PullRequestContextValue | undefined): string {
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
): WorkspaceSource {
  return {
    materialize: "lazy",
    mount: "pull-request-context",
    probeKeys: [defaultSourcePath],
    async getKeys() {
      return [defaultSourcePath]
    },
    async getItem(key) {
      return {
        content: renderPullRequestContextMarkdown(context.get<PullRequestContextValue>(contextKey)),
        key,
        mediaType: "text/markdown",
      }
    },
  }
}

export function pullRequestContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  const TSourceMap extends Record<string, WorkspaceSourceInput> | undefined = undefined,
  const TContextKey extends string = "pullRequest",
>(
  options: PullRequestContextOptions<TRuntimeConfig, Name> & { contextKey?: TContextKey, sources?: TSourceMap | PullRequestContextSources<TRuntimeConfig, Name> } = {},
): AgentCapabilityDefinition<TRuntimeConfig, Name, PullRequestContextCapabilityTypeContract<TContextKey>> {
  const contextKey = options.contextKey || "pullRequest"
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
    id: options.id || "pull-request-context",
    metadata: {
      contextKey,
      kind: "pull-request-context",
      workspaceOptional: !hasCustomWorkspaceContribution,
    },
    prepare: recordContext,
    triggers: options.triggers,
    workspace: async (context): Promise<AgentCapabilityWorkspaceContribution | undefined> => {
      await recordContext(context)
      const sources = await resolveMaybeFunction(options.sources, context)
      const rules = await resolveMaybeFunction(options.rules, context)
      return {
        ...(rules ? { rules } : {}),
        sources: {
          [defaultSourceKey]: pullRequestContextSource(context.context, contextKey),
          ...(sources || {}),
        },
      }
    },
  })
}
