import { getAgentMessageText } from "./messages.ts"
import {
  applyCapabilityInstructionSlots,
  applyCapabilityToolTransforms,
} from "./capability-runtime.ts"
import { mergeAgentToolSets } from "./skills.ts"
import {
  applyAgentToolPolicies,
  withAgentToolStepReporting,
} from "./tool-runtime.ts"

import type {
  AgentAdapter,
  AgentAdapterInstructions,
  AgentAdapterInstructionsValue,
  AgentAdapterMetadataContext,
  AgentAdapterResult,
  AgentAdapterRunContext,
  AgentRuntimeConfig,
  AgentToolSet,
  AgentToolResolverWithWorkspace,
  MaybePromise,
} from "./types.ts"
import type { AgentMessage } from "./messages.ts"
import type { WorkspaceName } from "@vitehub/workspace"

export interface TanStackAiAdapterOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  adapter: unknown
  agentLoopStrategy?: unknown
  instructions?: AgentAdapterInstructions<TRuntimeConfig, Name>
  options?: Record<string, unknown>
  tools?: AgentToolResolverWithWorkspace<TRuntimeConfig, Name>
  [key: string]: unknown
}

type TanStackMessage = {
  content: string
  role: "assistant" | "system" | "tool" | "user"
  toolCallId?: string
}

function toTextContent(message: AgentMessage): string {
  return getAgentMessageText(message) || message.parts.map((part) => {
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

export function toTanStackAiMessages(messages: AgentMessage[]): TanStackMessage[] {
  return messages.map(message => ({
    content: toTextContent(message),
    role: message.role,
  }))
}

function joinInstructions(...parts: Array<AgentAdapterInstructionsValue | undefined>) {
  return parts
    .flatMap(part => Array.isArray(part) ? part : [part])
    .map(part => part?.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function resolveInstructions(options: TanStackAiAdapterOptions, context: AgentAdapterMetadataContext) {
  const parts = Array.isArray(options.instructions) ? options.instructions : [options.instructions]
  const instructions = await Promise.all(parts.map(part => typeof part === "function"
    ? part(context)
    : part))

  return joinInstructions(...instructions)
}

async function resolveTools(options: TanStackAiAdapterOptions, context: AgentAdapterMetadataContext, runContext: AgentAdapterRunContext) {
  const resolved = options.tools
    ? typeof options.tools === "function"
    ? await options.tools(context)
    : await options.tools
    : undefined
  const merged = mergeAgentToolSets(resolved as AgentToolSet | undefined, runContext.tools)
  const transformed = await applyCapabilityToolTransforms(merged, runContext.capabilityToolTransforms)
  if (!transformed) return []
  const reportToolStep = runContext.devtools?.reportToolStep
  const tools = withAgentToolStepReporting(applyAgentToolPolicies(transformed) || {}, reportToolStep as never)
  const { toolDefinition } = await import("@tanstack/ai")
  return Object.values(tools).map((tool) => {
    const definition = toolDefinition({
      description: tool.description || tool.name,
      inputSchema: tool.inputSchema as never,
      metadata: tool.metadata,
      name: tool.name,
      needsApproval: tool.policy === "require-approval",
      outputSchema: tool.outputSchema as never,
    })
    return tool.execute ? definition.server(tool.execute as never) : definition
  })
}

async function createChatOptions(options: TanStackAiAdapterOptions, context: AgentAdapterRunContext, stream: boolean) {
  const metadataContext = {
    ...context.runtime,
    fs: context.workspace?.fs,
    workspace: context.workspace,
  } as AgentAdapterMetadataContext
  const baseInstructions = context.instructions ?? await resolveInstructions(options, metadataContext)
  const instructions = applyCapabilityInstructionSlots(baseInstructions, context.capabilityInstructions)
  const {
    adapter,
    instructions: _instructions,
    options: passthrough,
    tools: _tools,
    ...rest
  } = options
  return {
    ...rest,
    ...(passthrough || {}),
    adapter,
    agentLoopStrategy: options.agentLoopStrategy,
    messages: context.messages.length ? toTanStackAiMessages(context.messages) : context.prompt ? [{ content: context.prompt, role: "user" as const }] : [],
    stream,
    systemPrompts: instructions ? [instructions] : undefined,
    tools: await resolveTools(options, metadataContext, context),
  }
}

function toResult(value: unknown): AgentAdapterResult {
  return typeof value === "string"
    ? { raw: value, text: value }
    : { raw: value, text: typeof (value as { text?: unknown })?.text === "string" ? (value as { text: string }).text : undefined }
}

export function createTanStackAiProviderAdapter(options: TanStackAiAdapterOptions): AgentAdapter {
  return {
    async generate(context) {
      const { chat } = await import("@tanstack/ai")
      return toResult(await chat(await createChatOptions(options, context, false) as never))
    },
    async metadata(context) {
      const instructions = await resolveInstructions(options, context)
      return {
        instructions: instructions ? [instructions] : [],
        tools: [],
      }
    },
    name: "tanstack-ai",
    async stream(context) {
      const { chat } = await import("@tanstack/ai")
      return await chat(await createChatOptions(options, context, true) as never)
    },
  }
}
