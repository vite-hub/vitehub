import {
  resolveCapabilityPolicy,
  ViteHubError,
} from "@vite-hub/runtime"

import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolSet,
  AgentToolStepItem,
} from "./types.ts"

function isAgentToolDefinition(value: unknown): value is AgentToolDefinition {
  return typeof value === "object" && value !== null && "name" in value && typeof (value as { name?: unknown }).name === "string"
}

export function toJsonCompatibleValue(value: unknown): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  }
  catch {
    return String(value)
  }
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
    async execute(input, context) {
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
        throw new ViteHubError("CAPABILITY_DENIED", `[vitehub:runtime] Capability "${tool.name}" was denied.`, {
          details: { capability: tool.name },
        })
      }
      if (decision === "require-approval") {
        throw new ViteHubError("APPROVAL_REQUIRED", `[vitehub:runtime] Approval is required for "${tool.name}".`, {
          cause: approvalRequest,
          details: { capability: tool.name, requestId: approvalRequest.id },
          requestId: approvalRequest.id,
        })
      }
      if (decision === "retryable-failure") {
        throw new Error(`[vitehub:agent] Tool "${tool.name}" failed with a retryable policy decision.`)
      }

      return await execute(input, context)
    },
  }
}

export function applyAgentToolPolicies<TTools extends Record<string, unknown>>(tools: TTools | undefined): TTools | undefined {
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

export function withJsonCompatibleToolOutputs<TTools extends AgentToolSet>(tools: TTools): TTools {
  if (!tools || typeof tools !== "object") return tools

  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
      return [name, tool]
    }

    const execute = (tool as { execute: (...args: unknown[]) => unknown }).execute
    return [name, {
      ...tool,
      async execute(input: unknown, ...args: unknown[]) {
        return toJsonCompatibleValue(await execute.call(tool, input, ...args))
      },
    }]
  })) as TTools
}

type AgentToolStepReporter = AgentRuntimeContext["toolStepReporter"]

function createToolCallId(name: string): string {
  return `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function toolCallIdFromExecutionOptions(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return
  const toolCallId = (value as { toolCallId?: unknown }).toolCallId
  return typeof toolCallId === "string" && toolCallId ? toolCallId : undefined
}

function getErrorOutput(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function materializeSummary(output: unknown): unknown {
  if (!output || typeof output !== "object") return output
  const result = output as {
    bytes?: unknown
    directories?: unknown
    durationMs?: unknown
    files?: unknown
    path?: unknown
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

export async function reportWorkspaceMaterialization(
  tools: AgentToolSet | undefined,
  reportToolStep?: AgentToolStepReporter,
): Promise<void> {
  if (!tools || typeof tools !== "object") return
  const materializeTool = (tools as Record<string, unknown>).materialize_sources
  const execute = materializeTool && typeof materializeTool === "object" && typeof (materializeTool as { execute?: unknown }).execute === "function"
    ? (materializeTool as { execute: (input: unknown) => Promise<unknown> }).execute
    : undefined
  if (!execute) return

  const toolCall: AgentToolStepItem = {
    input: { path: "" },
    toolCallId: createToolCallId("materialize_sources"),
    toolName: "materialize_sources",
  }
  await reportToolStep?.({ toolCalls: [toolCall] })
  try {
    const output = await execute.call(materializeTool, toolCall.input)
    await reportToolStep?.({ toolResults: [{ ...toolCall, output: materializeSummary(output) }] })
  }
  catch (error) {
    await reportToolStep?.({ toolErrors: [{ ...toolCall, output: getErrorOutput(error) }] })
  }
}

export function withAgentToolStepReporting<TTools extends AgentToolSet>(tools: TTools, reportToolStep?: AgentToolStepReporter): TTools {
  if (!reportToolStep || !tools || typeof tools !== "object") {
    return tools
  }

  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { execute?: unknown }).execute !== "function") {
      return [name, tool]
    }
    if (name === "materialize_sources") {
      return [name, tool]
    }

    const execute = (tool as { execute: (...args: unknown[]) => unknown }).execute
    return [name, {
      ...tool,
      async execute(input: unknown, ...args: unknown[]) {
        const toolCall: AgentToolStepItem = {
          input,
          toolCallId: toolCallIdFromExecutionOptions(args[0]) ?? createToolCallId(name),
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
