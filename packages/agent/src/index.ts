import { ToolLoopAgent } from "ai"
import agentRegistry from "#vitehub/agent/registry"

import { formatUnknownAgentMessage } from "./registry-error.ts"

import type {
  Agent,
  AgentCallParameters,
  AgentStreamParameters,
  GenerateTextResult,
  ModelMessage,
  StreamTextResult,
  ToolSet,
} from "ai"
import type {
  AgentDefinition,
  AgentInput,
  AgentRegistry,
  AgentRegistryModule,
  AgentRequestBody,
  AgentRunContext,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  MaybeResolvable,
  ResolvedAgentRuntimeContext,
} from "./types.ts"

export type {
  Agent,
  AgentRequestBody,
  AgentDefinition,
  AgentExecution,
  AgentHandlerOptions,
  AgentInput,
  AgentIntegrationOption,
  AgentIntegrationsOptions,
  AgentModelInput,
  AgentModelProviderOptions,
  AgentModuleOptions,
  AgentProvidersOptions,
  AgentRegistryHandlerOptions,
  AgentRegistry,
  AgentRegistryModule,
  AgentRunContext,
  AgentRunHandler,
  AgentRunInput,
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeHooks,
  AgentRuntimeName,
  AgentSandboxProviderOptions,
  AgentSchedulerProviderOptions,
  AgentSettings,
  AgentStateProviderOptions,
  AgentToolResolver,
  AgentWaitUntil,
  CloudflareExportedHandlerFetchHandler,
  DiscoveredAgentDefinition,
  MaybePromise,
  MaybeResolvable,
  Resolvable,
  ResolvedAgentModuleOptions,
  ResolvedAgentRuntimeContext,
} from "./types.ts"

function isResolvable<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
): value is { resolve: (context: TContext) => T | Promise<T> } {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof value.resolve === "function"
}

async function resolveValue<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  if (isResolvable(value)) {
    return await value.resolve(context)
  }

  if (typeof value === "function") {
    return await (value as (context: TContext) => T | Promise<T>)(context)
  }

  return value
}

function hasAgentMethods(value: unknown): value is Agent {
  return typeof value === "object"
    && value !== null
    && "generate" in value
    && typeof (value as { generate?: unknown }).generate === "function"
    && "stream" in value
    && typeof (value as { stream?: unknown }).stream === "function"
}

function hasAgentDefinition(value: unknown): value is AgentDefinition {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function resolveRegistryModule<TContext extends AgentRuntimeContext>(
  module: AgentRegistryModule<TContext>,
): AgentInput<TContext> | undefined {
  return typeof module === "object" && module !== null && "default" in module
    ? module.default as AgentInput<TContext> | undefined
    : module as AgentInput<TContext>
}

function createResolvedRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentRuntimeContext<TRuntimeConfig>,
): ResolvedAgentRuntimeContext<TRuntimeConfig> {
  return {
    ...context,
    runtimeConfig: (context.runtimeConfig || {}) as TRuntimeConfig,
  }
}

export function defineAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
>(
  options: AgentSettings<TRuntimeConfig, CALL_OPTIONS, TOOLS> | Agent<CALL_OPTIONS, TOOLS>,
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS> {
  if (hasAgentMethods(options)) {
    const agent = options as Agent<CALL_OPTIONS, TOOLS>
    return {
      resolve: async () => agent,
    }
  }

  const { description, run, tools, ...settings } = options as AgentSettings<TRuntimeConfig, CALL_OPTIONS, TOOLS>

  return {
    description,
    run,
    async resolve(context) {
      const resolvedContext = createResolvedRuntimeContext(context)
      const resolvedTools = tools
        ? await resolveValue(tools, resolvedContext)
        : undefined

      return new ToolLoopAgent<CALL_OPTIONS, TOOLS>({
        ...(settings as unknown as ConstructorParameters<typeof ToolLoopAgent<CALL_OPTIONS, TOOLS>>[0]),
        tools: resolvedTools,
      })
    },
  }
}

export async function resolveAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<Agent> {
  if (hasAgentMethods(agent)) {
    return agent
  }

  if (hasAgentDefinition(agent)) {
    return await agent.resolve(context as never)
  }

  throw new TypeError("[vitehub] Invalid agent definition.")
}

export async function getAgentFromRegistry<TContext extends AgentRuntimeContext>(
  name: string,
  context: TContext,
  registry: AgentRegistry<TContext> = agentRegistry as AgentRegistry<TContext>,
): Promise<AgentInput<TContext>> {
  const loader = registry[name]
  if (!loader) {
    throw new Error(formatUnknownAgentMessage(name, Object.keys(registry).sort(), { prefix: true }))
  }

  const agent = resolveRegistryModule(await loader())
  if (!agent) {
    throw new Error(`[vitehub] Agent "${name}" did not export a valid default agent.`)
  }

  return agent
}

function createCallParameters<CALL_OPTIONS, TOOLS extends ToolSet>(
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): AgentCallParameters<CALL_OPTIONS, TOOLS> {
  const base = {
    abortSignal: input.abortSignal,
    timeout: input.timeout,
    ...("options" in input ? { options: input.options as CALL_OPTIONS } : {}),
  }

  if (input.messages) {
    return {
      ...base,
      messages: input.messages,
    } as AgentCallParameters<CALL_OPTIONS, TOOLS>
  }

  if (input.prompt) {
    return {
      ...base,
      prompt: input.prompt,
    } as AgentCallParameters<CALL_OPTIONS, TOOLS>
  }

  return {
    ...base,
    messages: [],
  } as AgentCallParameters<CALL_OPTIONS, TOOLS>
}

function createRunContext<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
  TOOLS extends ToolSet,
>(
  definition: AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): AgentRunContext<TRuntimeConfig, CALL_OPTIONS, TOOLS> {
  const resolvedContext = createResolvedRuntimeContext(context)

  return {
    ...resolvedContext,
    createAgent: () => definition.resolve(context),
    generateText: async options => await (await definition.resolve(context)).generate(options),
    input,
    streamText: async options => await (await definition.resolve(context)).stream(options),
  }
}

export async function runAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): Promise<Response | unknown> {
  if (hasAgentDefinition(agent) && agent.run) {
    const definition = agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>
    return await definition.run!(createRunContext(definition, context, input))
  }

  const resolved = await resolveAgent(agent, context)
  return await resolved.generate(createCallParameters(input) as never)
}

export async function streamAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): Promise<Response | unknown> {
  if (hasAgentDefinition(agent) && agent.run) {
    const definition = agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>
    return await definition.run!(createRunContext(definition, context, input))
  }

  const resolved = await resolveAgent(agent, context)
  return await resolved.stream(createCallParameters(input) as never)
}

export async function getAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<Agent> {
  return await resolveAgent(agent, context)
}
