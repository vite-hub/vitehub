import type { AgentToolDefinition, AgentToolSet, MaybePromise } from "./types.ts"

export type {
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
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
