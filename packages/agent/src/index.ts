import { ToolLoopAgent } from "ai"
import agentRegistry from "#vitehub/agent/registry"
import { getMessageText } from "@vitehub/messages"

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
  AgentRunResult,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentSettings,
  AgentToolDefinition,
  MaybeResolvable,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { Message, MessagePart, StreamEvent } from "@vitehub/messages"

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
  AgentRunResult,
  AgentRuntime,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeHooks,
  AgentRuntimeName,
  AgentSandboxProviderOptions,
  AgentSchedulerProviderOptions,
  AgentSettings,
  AgentToolDefinition,
  AgentToolPolicyContext,
  AgentToolPolicyDecision,
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

export type {
  Message,
  MessageMetadata,
  MessagePart,
  MessageRole,
  RunEvent,
  StreamEvent,
  ToolInvocation,
  ToolInvocationState,
} from "@vitehub/messages"

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
      if (!("model" in settings) || !settings.model) {
        throw new Error("[vitehub] Agent model is required unless the agent defines a custom run() handler.")
      }

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
      messages: toModelMessages(input.messages),
    } as AgentCallParameters<CALL_OPTIONS, TOOLS>
  }

  if (input.prompt) {
    if (Array.isArray(input.prompt)) {
      return {
        ...base,
        messages: toModelMessages(input.prompt),
      } as AgentCallParameters<CALL_OPTIONS, TOOLS>
    }

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

function toModelMessageContent(parts: MessagePart[]): string {
  return parts.map((part) => {
    if (part.type === "text") return part.text
    if (part.type === "error") return part.error
    if (part.type === "data") return JSON.stringify(part.data)
    if (part.type === "tool-call") return JSON.stringify({ input: part.input, toolCallId: part.id, toolName: part.name, type: "tool-call" })
    if (part.type === "tool-result") return JSON.stringify({ error: part.error, output: part.output, toolCallId: part.id, toolName: part.name, type: "tool-result" })
    if (part.type === "approval-request") return JSON.stringify({ input: part.input, reason: part.reason, toolCallId: part.id, toolName: part.name, type: "approval-request" })
    if (part.type === "source") return part.url || part.title || ""
    return ""
  }).filter(Boolean).join("\n")
}

export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map(message => ({
    content: getMessageText(message) || toModelMessageContent(message.parts),
    role: message.role,
  })) as ModelMessage[]
}

export function defineTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolDefinition<TInput, TOutput>,
): AgentToolDefinition<TInput, TOutput> {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("[vitehub] defineTool() requires a tool definition.")
  }
  if (!tool.name || typeof tool.name !== "string") {
    throw new TypeError("[vitehub] defineTool() requires a tool name.")
  }
  return tool
}

function toAgentRunResult(value: unknown): AgentRunResult {
  if (typeof value !== "object" || value === null) {
    return { raw: value, text: typeof value === "string" ? value : undefined }
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    raw: value,
    text: typeof result.text === "string" ? result.text : undefined,
    usage: result.usage,
    warnings: result.warnings,
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

function toStreamEvent(chunk: unknown): StreamEvent | undefined {
  if (typeof chunk === "string") {
    return { text: chunk, type: "text-delta" }
  }
  if (!chunk || typeof chunk !== "object") {
    return undefined
  }

  const value = chunk as Record<string, unknown>
  const type = String(value.type || "")
  if (type === "text-delta" || type === "text") {
    return { id: value.id as string | undefined, text: String(value.text || value.textDelta || value.delta || ""), type: "text-delta" }
  }
  if (type === "tool-input-start") {
    return { id: String(value.id || value.toolCallId), input: value.input, name: String(value.toolName || value.name), type: "tool-input-start" }
  }
  if (type === "tool-call") {
    return { id: String(value.toolCallId || value.id), input: value.input || value.args, name: String(value.toolName || value.name), type: "tool-call" }
  }
  if (type === "tool-result") {
    return { error: typeof value.error === "string" ? value.error : undefined, id: String(value.toolCallId || value.id), name: String(value.toolName || value.name), output: value.output || value.result, type: "tool-result" }
  }
  if (type === "error") {
    return { error: value.error instanceof Error ? value.error.message : String(value.error || "Unknown error"), type: "error" }
  }
  if (type === "finish") {
    return { reason: typeof value.finishReason === "string" ? value.finishReason : undefined, type: "finish" }
  }
  return undefined
}

async function* streamTextResultToEvents(value: unknown): AsyncIterable<StreamEvent> {
  const result = value as { fullStream?: AsyncIterable<unknown>, textStream?: AsyncIterable<string> }
  if (result.fullStream) {
    for await (const chunk of result.fullStream) {
      const event = toStreamEvent(chunk)
      if (event) yield event
    }
    return
  }
  if (result.textStream) {
    for await (const text of result.textStream) {
      yield { text, type: "text-delta" }
    }
  }
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
): Promise<Response | AgentRunResult | unknown> {
  if (hasAgentDefinition(agent) && agent.run) {
    const definition = agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>
    return await definition.run!(createRunContext(definition, context, input))
  }

  const resolved = await resolveAgent(agent, context)
  return toAgentRunResult(await resolved.generate(createCallParameters(input) as never))
}

export async function streamAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS, TOOLS>,
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  if (hasAgentDefinition(agent) && agent.run) {
    const definition = agent as unknown as AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>
    return await definition.run!(createRunContext(definition, context, input))
  }

  const resolved = await resolveAgent(agent, context)
  const result = await resolved.stream(createCallParameters(input) as never)
  return streamTextResultToEvents(result)
}

export async function getAgent<TContext extends AgentRuntimeContext>(
  agent: AgentInput<TContext>,
  context: TContext,
): Promise<Agent> {
  return await resolveAgent(agent, context)
}
