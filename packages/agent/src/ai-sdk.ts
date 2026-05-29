import { getMessageText } from "./messages.ts"
import {
  applyCapabilityInstructionSlots,
  applyCapabilityToolTransforms,
} from "./capability-runtime.ts"
import {
  applyAgentToolPolicies,
  reportWorkspaceMaterialization,
  withAgentToolStepReporting,
} from "./tool-runtime.ts"

import type {
  Agent,
  AssistantContent,
  GenerateTextResult,
  ModelMessage,
  StreamTextResult,
  ToolContent,
  ToolLoopAgentSettings,
  ToolResultPart,
  ToolSet,
} from "ai"
import type {
  AgentAdapter,
  AgentAdapterInstructions,
  AgentAdapterInstructionsValue,
  AgentAdapterMetadataContext,
  AgentAdapterRunContext,
  AgentAdapterResult,
  AgentModelInstrumentation,
  AgentRuntimeConfig,
  AgentToolSet,
  AgentToolResolverWithWorkspace,
  MaybePromise,
} from "./types.ts"
import type { Message, MessagePart } from "./messages.ts"
import type { WorkspaceName } from "@vitehub/workspace"

export interface AiSdkAdapterOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TCallOptions = unknown,
  TTools extends ToolSet = ToolSet,
  Name extends WorkspaceName = WorkspaceName,
> {
  adapterOptions?: AiSdkAdapterExecutionOptions<TCallOptions, TTools>
  instructions?: AgentAdapterInstructions<TRuntimeConfig, Name>
  instrumentModel?: AgentModelInstrumentation<TRuntimeConfig>
  model: ToolLoopAgentSettings<TCallOptions, TTools>["model"] | ((context: AgentAdapterMetadataContext<TRuntimeConfig, Name>) => MaybePromise<ToolLoopAgentSettings<TCallOptions, TTools>["model"]>)
  tools?: AgentToolResolverWithWorkspace<TRuntimeConfig, Name>
}

export type AiSdkAdapterExecutionOptions<
  TCallOptions = unknown,
  TTools extends ToolSet = ToolSet,
> = Omit<ToolLoopAgentSettings<TCallOptions, TTools>, "instructions" | "model" | "tools"> & {
  fallback?: boolean | AiSdkWorkspaceFallbackOptions
  stepLimit?: number
}

export interface AiSdkWorkspaceFallbackOptions {
  enabled?: boolean
  maxToolResults?: number
}

function toTextModelMessageContent(parts: MessagePart[]): string {
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

function toToolResultOutput(part: Extract<MessagePart, { type: "tool-result" }>): ToolResultPart["output"] {
  return (part.error ? { error: part.error } : part.output ?? null) as ToolResultPart["output"]
}

function toAssistantModelMessageContent(parts: MessagePart[]): AssistantContent {
  const content: Exclude<AssistantContent, string> = []

  for (const part of parts) {
    if (part.type === "text") {
      content.push({ text: part.text, type: "text" as const })
    }
    if (part.type === "tool-call") {
      content.push({
        input: part.input,
        toolCallId: part.id,
        toolName: part.name,
        type: "tool-call" as const,
      })
    }
    if (part.type === "tool-result") {
      content.push({
        output: toToolResultOutput(part),
        toolCallId: part.id,
        toolName: part.name,
        type: "tool-result" as const,
      })
    }
    if (part.type === "approval-request") {
      content.push({
        approvalId: part.id,
        toolCallId: part.id,
        type: "tool-approval-request" as const,
      })
    }
  }

  return content.length ? content : toTextModelMessageContent(parts)
}

function toToolModelMessageContent(parts: MessagePart[]): ToolContent {
  const content: ToolContent = []

  for (const part of parts) {
    if (part.type === "tool-result") {
      content.push({
        output: toToolResultOutput(part),
        toolCallId: part.id,
        toolName: part.name,
        type: "tool-result" as const,
      })
    }
    if (part.type === "approval-decision") {
      content.push({
        approvalId: part.id,
        approved: part.approved,
        reason: part.reason,
        type: "tool-approval-response" as const,
      })
    }
  }

  return content
}

export function toAiSdkModelMessages(messages: Message[]): ModelMessage[] {
  return messages
    .map((message): ModelMessage | undefined => {
      if (message.role === "assistant") {
        const content = toAssistantModelMessageContent(message.parts)
        return hasModelMessageContent(content)
          ? { content, role: message.role } as ModelMessage
          : undefined
      }
      if (message.role === "tool") {
        const content = toToolModelMessageContent(message.parts)
        return hasModelMessageContent(content)
          ? { content, role: message.role } as ModelMessage
          : undefined
      }
      const content = getMessageText(message) || toTextModelMessageContent(message.parts)
      return hasModelMessageContent(content)
        ? { content, role: message.role } as ModelMessage
        : undefined
    })
    .filter((message): message is ModelMessage => Boolean(message))
}

function hasModelMessageContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0
  return Array.isArray(content) ? content.length > 0 : content != null
}

function getCallInput(context: AgentAdapterRunContext) {
  const base = {
    abortSignal: context.input.abortSignal,
    timeout: context.input.timeout,
    ...("options" in context.input ? { options: context.input.options } : {}),
  }

  if (context.messages.length) {
    return {
      ...base,
      messages: toAiSdkModelMessages(context.messages),
    }
  }
  if (context.prompt) {
    return {
      ...base,
      prompt: context.prompt,
    }
  }
  return {
    ...base,
    messages: [],
  }
}

function getFallbackOptions(fallback: AiSdkAdapterExecutionOptions["fallback"]): Required<AiSdkWorkspaceFallbackOptions> {
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

function hasToolResults(result: { steps?: Array<{ content?: Array<{ type: string }> }> }) {
  return result.steps?.some(step => step.content?.some(content => content.type === "tool-result")) || false
}

function getPromptText(context: AgentAdapterRunContext) {
  if (context.prompt) return context.prompt
  const latestUserMessage = [...context.messages].reverse().find(message => message.role === "user")
  return latestUserMessage ? getMessageText(latestUserMessage) : ""
}

async function synthesizeWorkspaceFallback(
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  result: { steps?: Array<{ content?: Array<{ type: string, output?: unknown }> }> },
  maxToolResults: number,
) {
  const evidence = collectToolResults(result, maxToolResults)
  return await synthesizeWorkspaceFallbackFromEvidence(model, context, evidence)
}

async function synthesizeWorkspaceFallbackFromEvidence(
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  evidence: string[],
) {
  if (evidence.length === 0) return undefined

  const { generateText } = await import("ai")
  const summary = await generateText({
    model,
    system: [
      "Answer the user's last message using only the workspace tool results.",
      "If the tool results are insufficient, say what is missing.",
    ].join("\n"),
    prompt: [
      `User message:\n${getPromptText(context)}`,
      `Workspace tool results:\n${evidence.join("\n\n---\n\n")}`,
    ].join("\n\n"),
  })

  return summary.text.trim() || undefined
}

function streamEventText(event: unknown): string | undefined {
  if (typeof event === "string") return event
  if (typeof event !== "object" || event === null) return undefined
  const record = event as { delta?: unknown, text?: unknown, textDelta?: unknown, type?: unknown }
  if (record.type !== "text-delta" && record.type !== "text") return undefined
  const text = record.text ?? record.textDelta ?? record.delta
  return typeof text === "string" ? text : undefined
}

function streamToolResultOutput(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return undefined
  const record = event as { error?: unknown, errorText?: unknown, output?: unknown, result?: unknown, type?: unknown }
  if (record.type === "tool-result" || record.type === "tool-output-available") {
    return record.output ?? record.result
  }
  if (record.type === "tool-error" || record.type === "tool-output-error") {
    return record.error ?? record.errorText ?? record.output ?? record.result
  }
  return undefined
}

function streamEventType(event: unknown): string | undefined {
  return typeof event === "object" && event !== null && typeof (event as { type?: unknown }).type === "string"
    ? (event as { type: string }).type
    : undefined
}

function workspaceFallbackFinishEvent(finishEvent: unknown): unknown {
  return typeof finishEvent === "object" && finishEvent !== null
    ? { ...finishEvent, finishReason: "workspace-fallback", type: "finish" }
    : { finishReason: "workspace-fallback", type: "finish" }
}

function workspaceFallbackTextEvents(text: string): unknown[] {
  const id = "workspace-fallback"
  return [
    { id, type: "text-start" },
    { id, text, type: "text-delta" },
    { id, type: "text-end" },
  ]
}

function withAsyncIterator<T>(stream: ReadableStream<T>): AsyncIterable<T> & ReadableStream<T> {
  if (typeof (stream as AsyncIterable<T>)[Symbol.asyncIterator] === "function") {
    return stream as AsyncIterable<T> & ReadableStream<T>
  }

  Object.defineProperty(stream, Symbol.asyncIterator, {
    configurable: true,
    value: async function* () {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          yield value
        }
      }
      finally {
        reader.releaseLock()
      }
    },
  })
  return stream as AsyncIterable<T> & ReadableStream<T>
}

function toReadableAsyncIterableStream<T>(iterable: AsyncIterable<T>): AsyncIterable<T> & ReadableStream<T> {
  if (typeof (iterable as ReadableStream<T>).pipeThrough === "function") {
    return withAsyncIterator(iterable as ReadableStream<T>)
  }

  const iterator = iterable[Symbol.asyncIterator]()
  return withAsyncIterator(new ReadableStream<T>({
    async cancel() {
      await iterator.return?.()
    },
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done) {
          controller.close()
        }
        else {
          controller.enqueue(value)
        }
      }
      catch (error) {
        controller.error(error)
      }
    },
  }))
}

function cloneStreamTextResult<T extends object>(result: T, fullStream: AsyncIterable<unknown>): T {
  const clone = Object.create(Object.getPrototypeOf(result)) as T
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(result))
  let stream = toReadableAsyncIterableStream(fullStream)
  Object.defineProperty(clone, "fullStream", {
    configurable: true,
    enumerable: true,
    get() {
      const [next, branch] = stream.tee()
      stream = withAsyncIterator(next)
      return withAsyncIterator(branch)
    },
  })
  return clone
}

function withWorkspaceFallbackFullStream(
  stream: AsyncIterable<unknown>,
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  maxToolResults: number,
): AsyncIterable<unknown> {
  return (async function* () {
    let text = ""
    const evidence: string[] = []
    let finishEvent: unknown

    for await (const event of stream) {
      text += streamEventText(event) || ""
      const output = streamToolResultOutput(event)
      if (output !== undefined && evidence.length < maxToolResults) {
        evidence.push(JSON.stringify(output).slice(0, 4000))
      }
      const type = streamEventType(event)
      if (type === "finish" || type === "abort") {
        finishEvent = event
        continue
      }
      yield event
    }

    if (text.trim() || evidence.length === 0) {
      if (finishEvent) yield finishEvent
      return
    }

    const synthesized = await synthesizeWorkspaceFallbackFromEvidence(model, context, evidence)
    if (synthesized) {
      yield* workspaceFallbackTextEvents(synthesized)
      yield workspaceFallbackFinishEvent(finishEvent)
      return
    }
    if (finishEvent) yield finishEvent
  })()
}

function withWorkspaceFallbackStreamResult<T extends { fullStream?: AsyncIterable<unknown> }>(
  result: T,
  model: ToolLoopAgentSettings["model"],
  context: AgentAdapterRunContext,
  fallback: Required<AiSdkWorkspaceFallbackOptions>,
): T {
  if (!fallback.enabled || !result.fullStream) return result
  return cloneStreamTextResult(result as object, withWorkspaceFallbackFullStream(result.fullStream, model, context, fallback.maxToolResults)) as T
}

async function resolveValue<T>(value: T | ((context: AgentAdapterMetadataContext) => MaybePromise<T>), context: AgentAdapterMetadataContext): Promise<T> {
  return typeof value === "function" ? await (value as (context: AgentAdapterMetadataContext) => MaybePromise<T>)(context) : value
}

function joinInstructions(...parts: Array<AgentAdapterInstructionsValue | undefined>) {
  return parts
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function resolveInstructions(options: AiSdkAdapterOptions, context: AgentAdapterMetadataContext) {
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const instructions = await Promise.all(parts.map(part => typeof part === "function"
    ? part(context)
    : part))

  return joinInstructions(...instructions)
}

async function resolveTools(options: AiSdkAdapterOptions, context: AgentAdapterMetadataContext, reportToolStep?: AgentAdapterRunContext["devtools"] extends infer T ? T extends { reportToolStep?: infer R } ? R : never : never) {
  if (!options.tools) return undefined
  const resolved = await resolveValue(options.tools as never, context)
  const tools = applyAgentToolPolicies(resolved as AgentToolSet | undefined) || {}
  const { materialize_sources: materializeSources, ...reportableTools } = tools
  return {
    ...withAgentToolStepReporting(reportableTools, reportToolStep as never),
    ...(materializeSources ? { materialize_sources: materializeSources } : {}),
  }
}

function withRunCallbacks(settings: Record<string, unknown>, context: AgentAdapterRunContext) {
  const {
    onRunStepFinish,
    onRunToolCallFinish,
    onRunToolCallStart,
    onStepFinish,
    experimental_onToolCallFinish,
    experimental_onToolCallStart,
    ...rest
  } = settings as {
    experimental_onToolCallFinish?: (event: unknown) => MaybePromise<void>
    experimental_onToolCallStart?: (event: unknown) => MaybePromise<void>
    onRunStepFinish?: (step: unknown, context: unknown) => MaybePromise<void>
    onRunToolCallFinish?: (event: unknown, context: unknown) => MaybePromise<void>
    onRunToolCallStart?: (event: unknown, context: unknown) => MaybePromise<void>
    onStepFinish?: (step: unknown) => MaybePromise<void>
  } & Record<string, unknown>
  const callbackContext = {
    ...context.runtime,
    context: context.context,
    input: context.input,
    run: context.runtime.run,
  }

  return {
    ...rest,
    ...(onRunStepFinish
      ? {
          async onStepFinish(step: unknown) {
            await onStepFinish?.(step)
            await onRunStepFinish(step, callbackContext)
          },
        }
      : onStepFinish ? { onStepFinish } : {}),
    ...(onRunToolCallStart
      ? {
          async experimental_onToolCallStart(event: unknown) {
            await experimental_onToolCallStart?.(event)
            await onRunToolCallStart(event, callbackContext)
          },
        }
      : experimental_onToolCallStart ? { experimental_onToolCallStart } : {}),
    ...(onRunToolCallFinish
      ? {
          async experimental_onToolCallFinish(event: unknown) {
            await experimental_onToolCallFinish?.(event)
            await onRunToolCallFinish(event, callbackContext)
          },
        }
      : experimental_onToolCallFinish ? { experimental_onToolCallFinish } : {}),
  }
}

async function createAgent(options: AiSdkAdapterOptions, context: AgentAdapterRunContext) {
  const { ToolLoopAgent, stepCountIs } = await import("ai")
  const { runtimeConfig: _runtimeConfig, ...runtime } = context.runtime
  const metadataContext = {
    ...runtime,
    context: context.context,
    fs: context.workspace?.fs,
    workspace: context.workspace,
  } as AgentAdapterMetadataContext
  const model = await resolveValue(options.model as never, metadataContext)
  const instrumentedModel = options.instrumentModel
    ? await options.instrumentModel({ ...runtime, context: context.context, model, run: context.runtime.run })
    : model
  const instructions = context.instructions
    ?? applyCapabilityInstructionSlots(await resolveInstructions(options, metadataContext), context.capabilityInstructions)
  const adapterTools = await resolveTools(options, metadataContext, context.devtools?.reportToolStep)
  const resolvedTools = await applyCapabilityToolTransforms({
    ...context.tools,
    ...adapterTools,
  }, [])
  const providerTools = Object.fromEntries((context.providerTools || []).map(tool => [tool.name, {
    args: tool.args || {},
    id: tool.id,
    name: tool.name,
    type: "provider-defined",
  }]))
  const toolSet = { ...resolvedTools, ...providerTools }
  const {
    adapterOptions: _adapterOptions,
    instructions: _instructions,
    instrumentModel: _instrumentModel,
    model: _model,
    tools: _tools,
  } = options
  const {
    fallback: _fallback,
    stepLimit,
    ...settings
  } = options.adapterOptions || {}

  return {
    agent: new ToolLoopAgent({
      ...withRunCallbacks(settings, context),
      instructions,
      model: instrumentedModel as never,
      stopWhen: ((settings as Record<string, unknown>).stopWhen ?? stepCountIs(stepLimit ?? 20)) as never,
      ...(Object.keys(toolSet).length ? { tools: toolSet as never } : {}),
    }),
    model: instrumentedModel,
    tools: Object.keys(toolSet).length ? toolSet : undefined,
  }
}

export function createAiSdkAdapter(options: AiSdkAdapterOptions): AgentAdapter {
  const staticTools = typeof options.tools === "object" && options.tools
    ? withAgentToolStepReporting(applyAgentToolPolicies(options.tools as AgentToolSet) || {})
    : undefined
  return {
    async generate(context) {
      const { agent, model, tools } = await createAgent(options, context)
      if (context.workspace && tools && "materialize_sources" in tools) {
        await reportWorkspaceMaterialization(tools as AgentToolSet, context.devtools?.reportToolStep)
      }
      const result = await agent.generate(getCallInput(context) as never) as GenerateTextResult<ToolSet, never>
      const text = result.text.trim()
      if (text) return result as unknown as AgentAdapterResult

      const fallback = getFallbackOptions(options.adapterOptions?.fallback)
      if (fallback.enabled && (result.finishReason === "tool-calls" || hasToolResults(result))) {
        const synthesized = await synthesizeWorkspaceFallback(model as never, context, result, fallback.maxToolResults)
        if (synthesized) return { raw: result, text: synthesized }
      }

      return result as unknown as AgentAdapterResult
    },
    async metadata(context) {
      const instructions = await resolveInstructions(options, context)
      const tools = options.tools ? await resolveValue(options.tools as never, context) : undefined
      const metadataTools = tools as AgentToolSet | undefined
      return {
        instructions: instructions ? [instructions] : [],
        tools: Object.entries(metadataTools || {}).map(([name, tool]) => ({
          category: "workspace",
          description: tool.description,
          icon: name === "shell" ? "i-lucide-terminal" : "i-lucide-wrench",
          name,
          preset: "vitehub-workspace",
          status: "available" as const,
        })),
      }
    },
    name: "ai-sdk",
    ...(staticTools ? { tools: staticTools } : {}),
    async stream(context) {
      const { agent, model } = await createAgent(options, context)
      const result = await agent.stream(getCallInput(context) as never) as StreamTextResult<ToolSet, never>
      return withWorkspaceFallbackStreamResult(result, model as never, context, getFallbackOptions(options.adapterOptions?.fallback))
    },
  }
}

export function fromAiSdkAgent(agent: Agent): AgentAdapter {
  return {
    async generate(context) {
      return await agent.generate(getCallInput(context) as never)
    },
    name: "ai-sdk",
    async stream(context) {
      return await agent.stream(getCallInput(context) as never)
    },
  }
}
