import { getMessageText } from "@vitehub/messages"
import {
  applyAgentToolPolicies,
  withAgentToolStepReporting,
} from "./tool-runtime.ts"
import { mergeAgentToolSets, withSkillWriteValidation } from "./skills.ts"

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
import type { Message } from "@vitehub/messages"
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

function toTextContent(message: Message): string {
  return getMessageText(message) || message.parts.map((part) => {
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

export function toTanStackAiMessages(messages: Message[]): TanStackMessage[] {
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

async function resolveTools(options: TanStackAiAdapterOptions, context: AgentAdapterMetadataContext, reportToolStep?: AgentAdapterRunContext["devtools"] extends infer T ? T extends { reportToolStep?: infer R } ? R : never : never, extraTools?: AgentToolSet, skills?: AgentAdapterRunContext["skills"]) {
  if (!options.tools && !extraTools) return []
  const resolved = typeof options.tools === "function"
    ? await options.tools(context)
    : await options.tools
  const tools = withAgentToolStepReporting(applyAgentToolPolicies(withSkillWriteValidation(mergeAgentToolSets(resolved as AgentToolSet | undefined, extraTools), skills)) || {}, reportToolStep as never)
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
  const adapterInstructions = await resolveInstructions(options, metadataContext)
  const instructions = joinInstructions(adapterInstructions, context.instructions)
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
    tools: await resolveTools(options, metadataContext, context.devtools?.reportToolStep, context.tools, context.skills),
  }
}

function toResult(value: unknown): AgentAdapterResult {
  return typeof value === "string"
    ? { raw: value, text: value }
    : { raw: value, text: typeof (value as { text?: unknown })?.text === "string" ? (value as { text: string }).text : undefined }
}

export function tanstackAiAdapter(options: TanStackAiAdapterOptions): AgentAdapter {
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

export function fromTanStackAi(config: TanStackAiAdapterOptions): AgentAdapter {
  return tanstackAiAdapter(config)
}
