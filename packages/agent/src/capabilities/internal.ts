import type {
  AgentCapabilityContext,
  AgentToolDefinition,
} from "../types.ts"
import { agentDiagnostics } from "../agent-diagnostics.ts"

function primitiveHandle(context: AgentCapabilityContext, name: string): unknown {
  const handle = context.capabilities?.[name] as { value?: unknown } | unknown
  return typeof handle === "object" && handle !== null && "value" in handle
    ? (handle as { value?: unknown }).value
    : handle
}

export function requirePrimitive(context: AgentCapabilityContext, name: string): unknown {
  const handle = primitiveHandle(context, name)
  if (!handle) throw agentDiagnostics.AGENT_R0104({ message: `[vitehub] Capability "${name}" requires the ${name} primitive to be configured.` })
  return handle
}

export function defineInternalTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolDefinition<TInput, TOutput>,
): AgentToolDefinition<TInput, TOutput> {
  if (!tool || typeof tool !== "object") {
    throw agentDiagnostics.AGENT_R0105({ message: "[vitehub] tool definitions must be objects." })
  }
  if (!tool.name || typeof tool.name !== "string") {
    throw agentDiagnostics.AGENT_R0106({ message: "[vitehub] tool definitions require a tool name." })
  }
  return tool
}
