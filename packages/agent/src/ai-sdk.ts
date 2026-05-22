import { getMessageText } from "./messages.ts"
import {
  applyCapabilityInstructionSlots,
  applyCapabilityToolTransforms,
} from "./capability-runtime.ts"
import {
  applyAgentToolPolicies,
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
  return messages.map((message) => {
    if (message.role === "assistant") {
      return {
        content: toAssistantModelMessageContent(message.parts),
        role: message.role,
      }
    }
    if (message.role === "tool") {
      return {
        content: toToolModelMessageContent(message.parts),
        role: message.role,
      }
    }
    return {
      content: getMessageText(message) || toTextModelMessageContent(message.parts),
      role: message.role,
    }
  }) as ModelMessage[]
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

function materializeSummary(output: unknown): unknown {
  if (!output || typeof output !== "object") return output
  const result = output as {
    files?: unknown
    sources?: unknown
  }
  const files = typeof result.files === "number" ? result.files : 0
  const sources = Array.isArray(result.sources)
    ? result.sources.map(source => typeof source === "object" && source && "source" in source ? String((source as { source: unknown }).source) : "").filter(Boolean)
    : []
  const target = sources.length ? sources.join(" and ") : "workspace sources"
  return {
    ...result,
    summary: `Materialized ${target}${files ? ` (${files.toLocaleString()} file${files === 1 ? "" : "s"})` : ""}.`,
  }
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
    fs: context.workspace?.fs,
    workspace: context.workspace,
  } as AgentAdapterMetadataContext
  const model = await resolveValue(options.model as never, metadataContext)
  const instrumentedModel = options.instrumentModel
    ? await options.instrumentModel({ ...runtime, model, run: context.runtime.run })
    : model
  const instructions = context.instructions
    ?? applyCapabilityInstructionSlots(await resolveInstructions(options, metadataContext), context.capabilityInstructions)
  const adapterTools = await resolveTools(options, metadataContext, context.devtools?.reportToolStep)
  const tools = await applyCapabilityToolTransforms({
    ...context.tools,
    ...adapterTools,
  }, [])
  const toolSet = tools || {}
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
        const materializeTool = tools.materialize_sources
        const execute = materializeTool?.execute
        if (execute) {
          const reportToolStep = context.devtools?.reportToolStep
          const toolCall = {
            input: { path: "" },
            toolCallId: `materialize_sources-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            toolName: "materialize_sources",
          }
          await reportToolStep?.({ toolCalls: [toolCall] })
          try {
            const output = await execute.call(materializeTool, toolCall.input)
            await reportToolStep?.({ toolResults: [{ ...toolCall, output: materializeSummary(output) }] })
          }
          catch (error) {
            await reportToolStep?.({ toolErrors: [{ ...toolCall, output: error instanceof Error ? error.message : String(error) }] })
          }
        }
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
      const { agent } = await createAgent(options, context)
      return await agent.stream(getCallInput(context) as never) as StreamTextResult<ToolSet, never>
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
