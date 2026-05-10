import agentRegistry from "#vitehub/agent/registry"
import { getMessageText } from "@vitehub/messages"
import {
  ApprovalRequiredError,
  CapabilityDeniedError,
  resolveCapabilityPolicy,
  resolveRuntimeContext,
  resolveRuntimeValue,
} from "@vitehub/runtime"

import { formatUnknownAgentMessage } from "./registry-error.ts"

import type {
  Agent,
  AgentCallParameters,
  ModelMessage,
  ToolLoopAgentSettings,
  ToolSet,
} from "ai"
import type {
  AgentDefinition,
  AgentChatOptions,
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
  AgentToolStepItem,
  AgentChatAgentHooks,
  MaybePromise,
  MaybeResolvable,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type { Message, MessagePart, StreamEvent } from "@vitehub/messages"
import type {
  ReadonlyWorkspaceFacade,
  ReadonlyWorkspaceFs,
  WorkspaceDefinitionInput,
  WorkspaceFacadeToolOptions,
  WorkspaceName,
} from "@vitehub/workspace"

export type {
  Agent,
  AgentCapabilities,
  AgentCapabilityHandle,
  AgentChatAgentHookArgs,
  AgentChatAgentHooks,
  AgentChatEventHookArgs,
  AgentChatEventHooks,
  AgentChatOptions,
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
  AgentToolStep,
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

async function resolveValue<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  return await resolveRuntimeValue(value, context)
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
  return resolveRuntimeContext(context) as ResolvedAgentRuntimeContext<TRuntimeConfig>
}

async function createToolLoopAgent<CALL_OPTIONS, TOOLS extends ToolSet>(
  settings: Omit<AgentSettings<AgentRuntimeConfig, CALL_OPTIONS, TOOLS>, "description" | "run" | "tools">,
  tools: TOOLS | undefined,
): Promise<Agent<CALL_OPTIONS, TOOLS>> {
  const ai = await import("ai")
  const { ToolLoopAgent } = ai
  return new ToolLoopAgent<CALL_OPTIONS, TOOLS>({
    ...(settings as unknown as ConstructorParameters<typeof ToolLoopAgent<CALL_OPTIONS, TOOLS>>[0]),
    tools,
  })
}

function isAgentToolDefinition(value: unknown): value is AgentToolDefinition {
  return typeof value === "object" && value !== null && "name" in value && typeof (value as { name?: unknown }).name === "string"
}

function createApprovalRequest(name: string, input: unknown, reason?: string) {
  return {
    capability: name,
    id: `approval_${name}_${Math.random().toString(36).slice(2, 10)}`,
    input,
    reason,
    state: "awaiting-approval" as const,
  }
}

function withToolPolicy(tool: AgentToolDefinition): AgentToolDefinition {
  if (!tool.policy || typeof tool.execute !== "function") {
    return tool
  }

  const execute = tool.execute
  const policy = tool.policy

  return {
    ...tool,
    async execute(input) {
      const decision = typeof policy === "function"
        ? await policy({
            name: tool.name,
            input,
          })
        : await resolveCapabilityPolicy(policy, {
            capability: tool.name,
            input,
            operation: "tool.execute",
          })

      const approvalRequest = createApprovalRequest(tool.name, input)

      if (decision === "deny") {
        throw new CapabilityDeniedError(tool.name)
      }
      if (decision === "require-approval") {
        throw new ApprovalRequiredError(approvalRequest)
      }
      if (decision === "retryable-failure") {
        throw new Error(`[vitehub:agent] Tool "${tool.name}" failed with a retryable policy decision.`)
      }

      return await execute(input)
    },
  }
}

function applyToolPolicies<TTools extends Record<string, unknown>>(tools: TTools | undefined): TTools | undefined {
  if (!tools || typeof tools !== "object") {
    return tools
  }

  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!isAgentToolDefinition(tool)) {
      return [name, tool]
    }
    return [name, withToolPolicy(tool)]
  })) as TTools
}

type AgentToolStepReporter = NonNullable<AgentRuntimeContext["devtools"]>["reportToolStep"]

function createToolCallId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getErrorOutput(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withToolStepReporting<TTools extends ToolSet>(tools: TTools, reportToolStep?: AgentToolStepReporter): TTools {
  if (!reportToolStep || !tools || typeof tools !== "object") {
    return tools
  }

  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
      return [name, tool]
    }

    const execute = (tool as { execute: (...args: unknown[]) => unknown }).execute
    return [name, {
      ...tool,
      async execute(input: unknown, ...args: unknown[]) {
        const toolCall: AgentToolStepItem = {
          input,
          toolCallId: createToolCallId(name),
          toolName: name,
        }

        await reportToolStep({ toolCalls: [toolCall] })
        try {
          const output = await execute.call(tool, input, ...args)
          await reportToolStep({ toolResults: [{ ...toolCall, output }] })
          return output
        }
        catch (error) {
          await reportToolStep({ toolErrors: [{ ...toolCall, output: getErrorOutput(error) }] })
          throw error
        }
      },
    }]
  })) as TTools
}

function defineBaseAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = ToolSet,
>(
  options: (AgentSettings<TRuntimeConfig, CALL_OPTIONS, TOOLS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }) | Agent<CALL_OPTIONS, TOOLS>,
): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS> {
  if (hasAgentMethods(options)) {
    const agent = options as Agent<CALL_OPTIONS, TOOLS>
    return {
      resolve: async () => agent,
    }
  }

  const { chat, description, hooks, run, tools, ...settings } = options as AgentSettings<TRuntimeConfig, CALL_OPTIONS, TOOLS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }

  return {
    chat,
    description,
    hooks,
    run,
    async resolve(context) {
      if (!("model" in settings) || !settings.model) {
        throw new Error("[vitehub] Agent model is required unless the agent defines a custom run() handler.")
      }

      const resolvedContext = createResolvedRuntimeContext(context)
      const resolvedTools = tools
        ? applyToolPolicies(await resolveValue(tools, resolvedContext))
        : undefined

      return await createToolLoopAgent(settings, resolvedTools as TOOLS | undefined)
    },
  }
}

type WorkspaceRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig> =
  ResolvedAgentRuntimeContext<TRuntimeConfig>

type WorkspaceModel<TRuntimeConfig extends AgentRuntimeConfig> =
  | ToolLoopAgentSettings["model"]
  | ((context: WorkspaceRuntimeContext<TRuntimeConfig>) => MaybePromise<ToolLoopAgentSettings["model"]>)

type WorkspaceAgentInstructionsInput = string | string[]

interface WorkspaceAgentInstructionsContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends WorkspaceRuntimeContext<TRuntimeConfig> {
  fs: ReadonlyWorkspaceFs<Name>
  workspace: ReadonlyWorkspaceFacade<Name>
}

type WorkspaceAgentInstructions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | WorkspaceAgentInstructionsInput
  | ((context: WorkspaceAgentInstructionsContext<TRuntimeConfig, Name>) => MaybePromise<WorkspaceAgentInstructionsInput>)

export interface WorkspaceAgentFallbackOptions {
  enabled?: boolean
  maxToolResults?: number
}

export type WorkspaceAgentWorkspaceOptions = Omit<WorkspaceDefinitionInput, "name">

export interface WorkspaceAgentOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  chat?: AgentChatOptions<TRuntimeConfig>
  description?: string
  fallback?: boolean | WorkspaceAgentFallbackOptions
  hooks?: AgentChatAgentHooks<TRuntimeConfig>
  instructions?: WorkspaceAgentInstructions<TRuntimeConfig, Name>
  model: WorkspaceModel<TRuntimeConfig>
  name?: string
  stepLimit?: number
  toolOptions?: WorkspaceFacadeToolOptions
  workspace: WorkspaceAgentWorkspaceOptions
}

export type WorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = AgentDefinition<TRuntimeConfig, never, ToolSet> & WorkspaceDefinitionInput & {
  __vitehubWorkspaceAgent: true
  __vitehubWorkspaceAgentOptions: WorkspaceAgentOptions<TRuntimeConfig, Name>
}

export interface WorkspaceAgentDefaults<Name extends WorkspaceName = WorkspaceName> {
  instructionsFile?: string
  name?: string
  workspace?: Name
}

export interface DefineAgent {
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    Name extends WorkspaceName = WorkspaceName,
  >(
    options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  ): WorkspaceAgentDefinition<TRuntimeConfig, Name>
  <
    TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
    CALL_OPTIONS = never,
    TOOLS extends ToolSet = ToolSet,
  >(
    options: (AgentSettings<TRuntimeConfig, CALL_OPTIONS, TOOLS> & { chat?: AgentChatOptions<TRuntimeConfig>, hooks?: AgentChatAgentHooks<TRuntimeConfig> }) | Agent<CALL_OPTIONS, TOOLS>,
  ): AgentDefinition<TRuntimeConfig, CALL_OPTIONS, TOOLS>
}

function isWorkspaceAgentOptions(value: unknown): value is WorkspaceAgentOptions {
  return typeof value === "object"
    && value !== null
    && "workspace" in value
    && typeof (value as { workspace?: unknown }).workspace === "object"
    && (value as { workspace?: unknown }).workspace !== null
}

function isModelResolver<TRuntimeConfig extends AgentRuntimeConfig>(
  model: WorkspaceModel<TRuntimeConfig>,
): model is (context: WorkspaceRuntimeContext<TRuntimeConfig>) => MaybePromise<ToolLoopAgentSettings["model"]> {
  return typeof model === "function"
}

async function resolveModel<TRuntimeConfig extends AgentRuntimeConfig>(
  model: WorkspaceModel<TRuntimeConfig>,
  context: WorkspaceRuntimeContext<TRuntimeConfig>,
) {
  return isModelResolver(model) ? await model(context) : model
}

function getPromptText(input: AgentRunInput) {
  if (typeof input.prompt === "string") return input.prompt

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : [])
  const latestUserMessage = [...messages].reverse().find(message => message.role === "user")

  if (!latestUserMessage) return ""
  return getMessageText(latestUserMessage)
}

function getAgentCall(input: AgentRunInput) {
  if (input.messages) return { messages: toModelMessages(input.messages) }
  if (Array.isArray(input.prompt)) return { messages: toModelMessages(input.prompt) }
  if (input.prompt) return { prompt: input.prompt }
  return { messages: [] }
}

async function readDefaultInstructions(
  workspace: ReadonlyWorkspaceFacade,
  path: string | undefined,
) {
  if (!path) return undefined
  try {
    return await workspace.fs.readFile(path)
  }
  catch {
    return undefined
  }
}

function joinInstructions(...parts: Array<WorkspaceAgentInstructionsInput | undefined>) {
  return parts
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function resolveWorkspaceInstructions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  workspace: ReadonlyWorkspaceFacade<Name>,
  context: WorkspaceRuntimeContext<TRuntimeConfig>,
  defaults: WorkspaceAgentDefaults<Name>,
) {
  const instructions = typeof options.instructions === "function"
    ? await options.instructions({
        ...context,
        fs: workspace.fs,
        workspace,
      })
    : options.instructions
  const defaultInstructions = options.instructions === undefined
    ? await readDefaultInstructions(workspace, defaults.instructionsFile)
    : undefined
  return joinInstructions(instructions, defaultInstructions)
}

function getFallbackOptions(fallback: WorkspaceAgentOptions["fallback"]): Required<WorkspaceAgentFallbackOptions> {
  if (fallback === false) return { enabled: false, maxToolResults: 0 }
  if (fallback === true || fallback === undefined) return { enabled: true, maxToolResults: 8 }
  return {
    enabled: fallback.enabled ?? true,
    maxToolResults: fallback.maxToolResults ?? 8,
  }
}

function collectToolResults(
  result: { steps?: Array<{ content?: Array<{ type: string, output?: unknown }> }> },
  maxToolResults: number,
) {
  const parts: string[] = []

  for (const step of result.steps || []) {
    for (const content of step.content || []) {
      if (content.type !== "tool-result") continue
      parts.push(JSON.stringify(content.output).slice(0, 4000))
      if (parts.length >= maxToolResults) return parts
    }
  }

  return parts
}

async function synthesizeWorkspaceFallback<TRuntimeConfig extends AgentRuntimeConfig>(
  model: ToolLoopAgentSettings["model"],
  context: AgentRunContext<TRuntimeConfig>,
  result: { steps?: Array<{ content?: Array<{ type: string, output?: unknown }> }> },
  maxToolResults: number,
) {
  const evidence = collectToolResults(result, maxToolResults)
  if (evidence.length === 0) return undefined

  const { generateText } = await import("ai")
  const summary = await generateText({
    model,
    system: [
      "Answer the user's last message using only the workspace tool results.",
      "If the tool results are insufficient, say what is missing.",
    ].join("\n"),
    prompt: [
      `User message:\n${getPromptText(context.input)}`,
      `Workspace tool results:\n${evidence.join("\n\n---\n\n")}`,
    ].join("\n\n"),
  })

  return summary.text.trim() || undefined
}

function createWorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  options: WorkspaceAgentOptions<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name> = {},
): WorkspaceAgentDefinition<TRuntimeConfig, Name> {
  const workspaceName = defaults.workspace
  const definition = defineBaseAgent<TRuntimeConfig, never, ToolSet>({
    chat: options.chat,
    description: options.description,
    hooks: options.hooks,
    async run(context) {
      if (!workspaceName) {
        throw new Error("[vitehub] Workspace agents require an inferred workspace name from server/agents/<name>/config.ts.")
      }
      const { useWorkspace } = await import("@vitehub/workspace")
      const { stepCountIs, ToolLoopAgent } = await import("ai")
      const workspace = useWorkspace(workspaceName)
      const model = await resolveModel(options.model, context)
      const instructions = await resolveWorkspaceInstructions(options, workspace, context, defaults)
      const reportToolStep = context.devtools?.reportToolStep
      const agent = new ToolLoopAgent({
        instructions,
        model,
        stopWhen: stepCountIs(options.stepLimit ?? 20),
        tools: withToolStepReporting(workspace.tools(options.toolOptions), reportToolStep),
      })
      const result = await agent.generate({
        ...getAgentCall(context.input),
        abortSignal: context.input.abortSignal,
        timeout: context.input.timeout,
      })
      const text = result.text.trim()

      if (text) return text

      const fallback = getFallbackOptions(options.fallback)
      if (fallback.enabled && result.finishReason === "tool-calls") {
        const synthesized = await synthesizeWorkspaceFallback(model, context, result, fallback.maxToolResults)
        if (synthesized) return synthesized
      }

      return result
    },
  }) as WorkspaceAgentDefinition<TRuntimeConfig, Name>

  Object.assign(definition, options.workspace, {
    __vitehubWorkspaceAgent: true,
    __vitehubWorkspaceAgentOptions: options,
  })
  return definition
}

export function withWorkspaceAgentDefaults<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(
  definition: WorkspaceAgentDefinition<TRuntimeConfig, Name>,
  defaults: WorkspaceAgentDefaults<Name>,
): WorkspaceAgentDefinition<TRuntimeConfig, Name> {
  if (!definition?.__vitehubWorkspaceAgent) return definition
  return createWorkspaceAgentDefinition(definition.__vitehubWorkspaceAgentOptions, defaults)
}

export const defineAgent: DefineAgent = ((options: unknown) => {
  return isWorkspaceAgentOptions(options)
    ? createWorkspaceAgentDefinition(options)
    : defineBaseAgent(options as never)
}) as DefineAgent

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
    if (part.type === "approval-decision") return JSON.stringify({ approved: part.approved, reason: part.reason, toolCallId: part.id, type: "approval-decision" })
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
    return { id: String(value.toolCallId ?? value.id), input: value.input ?? value.args, name: String(value.toolName ?? value.name), type: "tool-call" }
  }
  if (type === "tool-result") {
    return { error: typeof value.error === "string" ? value.error : undefined, id: String(value.toolCallId ?? value.id), name: String(value.toolName ?? value.name), output: value.output ?? value.result, type: "tool-result" }
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
