import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityTypeContract,
  AgentCapabilityWorkspaceContribution,
  AgentRuntimeConfig,
  AgentTriggerDefinition,
  MaybePromise,
} from "../types.ts"
import type {
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
  TSourceName extends string = string,
  TContextKey extends string = "pullRequest",
> = AgentCapabilityTypeContract & {
  invocationContext: Record<TContextKey, PullRequestContextValue>
  workspaceSources: TSourceName
}

async function resolveMaybeFunction<TValue, TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  value: TValue | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<TValue | false | null | undefined>) | undefined,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): Promise<TValue | undefined> {
  const resolved = typeof value === "function"
    ? await (value as (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<TValue | false | null | undefined>)(context)
    : value
  return resolved || undefined
}

export function pullRequestContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  const TSourceMap extends Record<string, WorkspaceSourceInput> | undefined = undefined,
  const TContextKey extends string = "pullRequest",
>(
  options: PullRequestContextOptions<TRuntimeConfig, Name> & { contextKey?: TContextKey, sources?: TSourceMap | PullRequestContextSources<TRuntimeConfig, Name> } = {},
): AgentCapabilityDefinition<TRuntimeConfig, Name, PullRequestContextCapabilityTypeContract<Extract<keyof NonNullable<TSourceMap>, string>, TContextKey>> {
  const contextKey = options.contextKey || "pullRequest"
  const hasWorkspaceContribution = options.sources !== undefined || options.rules !== undefined
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
    },
    prepare: recordContext,
    triggers: options.triggers,
    ...(hasWorkspaceContribution
      ? {
          workspace: async (context): Promise<AgentCapabilityWorkspaceContribution | undefined> => {
            await recordContext(context)
            const sources = await resolveMaybeFunction(options.sources, context)
            const rules = await resolveMaybeFunction(options.rules, context)
            if (!sources && !rules) return
            return {
              ...(rules ? { rules } : {}),
              ...(sources ? { sources } : {}),
            }
          },
        }
      : {}),
  })
}
