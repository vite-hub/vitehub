import {
  resolveCapabilityPolicy,
  ViteHubError,
} from "@vite-hub/runtime"
import { hasRuntimeType } from "./internal/runtime-type.ts"

import type {
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolSet,
  AgentToolStepItem,
} from "./types.ts"

function isAgentToolDefinition(value: unknown): value is AgentToolDefinition {
  // SAFETY: the object and property guards establish the structural tool-name boundary.
  return hasRuntimeType(value, "object") && value !== null && "name" in value && hasRuntimeType((value as { name?: unknown }).name, "string")
}

export const agentToolPolicyApproveSymbol: unique symbol = Symbol("vitehub.agent.tool-policy-approve")

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
  if (!tool.policy || !hasRuntimeType(tool.execute, "function")) {
    return tool
  }

  const execute = tool.execute
  const policy = tool.policy
  const approvedInputs = new Set<unknown>()

  // SAFETY: the wrapper preserves every AgentToolDefinition member and the execute contract.
  return {
    ...tool,
    [agentToolPolicyApproveSymbol](input: unknown) {
      approvedInputs.add(input)
    },
    async execute(input, context) {
      if (approvedInputs.delete(input)) {
        context?.abortSignal?.throwIfAborted()
        return await execute(input, context)
      }
      const decision = hasRuntimeType(policy, "function")
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

      context?.abortSignal?.throwIfAborted()
      return await execute(input, context)
    },
  } as AgentToolDefinition
}

export function applyAgentToolPolicies<TTools extends Record<string, unknown>>(tools: TTools | undefined): TTools | undefined {
  if (!tools || !hasRuntimeType(tools, "object")) {
    return tools
  }

  // SAFETY: entries preserve every key and only replace recognized tool definitions with the same contract.
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    if (!isAgentToolDefinition(tool)) {
      return [name, tool]
    }
    return [name, withToolPolicy(tool)]
  })) as TTools
}

export function withJsonCompatibleToolOutputs<TTools extends AgentToolSet>(tools: TTools): TTools {
  if (!tools || !hasRuntimeType(tools, "object")) return tools

  // SAFETY: entries preserve every key and wrapped execute functions retain each tool's external contract.
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    // SAFETY: the object guard establishes the structural execute-member boundary.
    if (!tool || !hasRuntimeType(tool, "object") || !hasRuntimeType((tool as { execute?: unknown }).execute, "function")) {
      return [name, tool]
    }

    // SAFETY: the callable guard above establishes the execute signature used by this transparent wrapper.
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
  if (!value || !hasRuntimeType(value, "object")) return
  // SAFETY: the object guard establishes the structural toolCallId-member boundary.
  const toolCallId = (value as { toolCallId?: unknown }).toolCallId
  return hasRuntimeType(toolCallId, "string") && toolCallId ? toolCallId : undefined
}

function getErrorOutput(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function materializeSummary(output: unknown): unknown {
  if (!output || !hasRuntimeType(output, "object")) return output
  // SAFETY: the object guard establishes the optional materialization-result members read below.
  const result = output as {
    bytes?: unknown
    directories?: unknown
    durationMs?: unknown
    files?: unknown
    path?: unknown
    sources?: unknown
  }
  const files = hasRuntimeType(result.files, "number") ? result.files : 0
  const sources = Array.isArray(result.sources)
    ? result.sources.map(source => hasRuntimeType(source, "object") && source && "source" in source
        // SAFETY: the object and property guards establish the source member read here.
        ? String((source as { source: unknown }).source)
        : "").filter(Boolean)
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
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!tools || !hasRuntimeType(tools, "object")) return
  // SAFETY: AgentToolSet is structurally keyed and the object guard establishes record access.
  const materializeTool = (tools as Record<string, unknown>).materialize_sources
  const execute = materializeTool && hasRuntimeType(materializeTool, "object")
    // SAFETY: the object guard establishes the structural execute-member boundary.
    && hasRuntimeType((materializeTool as { execute?: unknown }).execute, "function")
    // SAFETY: the callable guard establishes the materialization execute contract supplied by AgentToolSet.
    ? (materializeTool as { execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown> }).execute
    : undefined
  if (!execute) return

  const toolCall: AgentToolStepItem = {
    input: { path: "" },
    toolCallId: createToolCallId("materialize_sources"),
    toolName: "materialize_sources",
  }
  await reportToolStep?.({ toolCalls: [toolCall] })
  try {
    abortSignal?.throwIfAborted()
    const output = abortSignal
      ? await execute.call(materializeTool, toolCall.input, { abortSignal })
      : await execute.call(materializeTool, toolCall.input)
    abortSignal?.throwIfAborted()
    await reportToolStep?.({ toolResults: [{ ...toolCall, output: materializeSummary(output) }] })
  }
  catch (error) {
    await reportToolStep?.({ toolErrors: [{ ...toolCall, output: getErrorOutput(error) }] })
    if (abortSignal?.aborted) throw abortSignal.reason
  }
}

export function withAgentToolStepReporting<TTools extends AgentToolSet>(tools: TTools, reportToolStep?: AgentToolStepReporter): TTools {
  if (!reportToolStep || !tools || !hasRuntimeType(tools, "object")) {
    return tools
  }

  // SAFETY: entries preserve every key and wrapped execute functions retain each tool's external contract.
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    // SAFETY: the object guard establishes the structural execute-member boundary.
    if (!tool || !hasRuntimeType(tool, "object") || !hasRuntimeType((tool as { execute?: unknown }).execute, "function")) {
      return [name, tool]
    }
    if (name === "materialize_sources") {
      return [name, tool]
    }

    // SAFETY: the callable guard above establishes the execute signature used by this reporting wrapper.
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
          // SAFETY: AI SDK tool execution passes its execution-options object as the first trailing argument.
          const execution = args[0] as { abortSignal?: AbortSignal } | undefined
          execution?.abortSignal?.throwIfAborted()
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
