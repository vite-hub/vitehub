import { capabilityWorkspaceSources, defineCapability } from "../capability-runtime.ts"
import { awaitAgentInvocationResult } from "../agent-invocation.ts"
import { withResolvedAgentInvokerInput } from "../invoker.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentInput,
  AgentRunInput,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentToolDefinition,
  AgentToolSet,
} from "../types.ts"
import type { Message } from "../messages.ts"
import type { WorkspaceDefinition, WorkspaceName } from "@vite-hub/workspace"
import type { JSONSchema7 } from "json-schema"

export interface SubagentToolInput<
  CALL_OPTIONS = unknown,
  TContext extends object = Record<string, unknown>,
> {
  context?: TContext
  message: string | Message
  options?: CALL_OPTIONS
  timeout?: number
}

export interface SubagentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContext extends object = Record<string, unknown>,
> {
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>
  description: string
  toolName?: string
}

export interface SubagentsOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TAgents extends Record<string, SubagentDefinition<TRuntimeConfig, any, any>> = Record<string, SubagentDefinition<TRuntimeConfig>>,
> {
  agents: TAgents
  id?: string
}

function assertSubagentName(name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new TypeError(`[vitehub] subagents() key "${name}" must be a lowercase stable identifier.`)
  }
}

function toolNameFor(name: string, definition: SubagentDefinition): string {
  const toolName = definition.toolName || `run_${name.replaceAll("-", "_")}`
  if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
    throw new TypeError(`[vitehub] subagents() tool name "${toolName}" must be lowercase and use underscores instead of dashes.`)
  }
  return toolName
}

function inputSchema(description: string): JSONSchema7 {
  return {
    additionalProperties: false,
    properties: {
      context: { additionalProperties: true, description: "Structured task context for the subagent.", type: "object" },
      message: { description, type: "string" },
      options: { additionalProperties: true, description: "Agent call options for the subagent.", type: "object" },
      timeout: { description: "Optional timeout in milliseconds.", type: "number" },
    },
    required: ["message"],
    type: "object",
  }
}

function normalizeAgents<TRuntimeConfig extends AgentRuntimeConfig>(
  options: SubagentsOptions<TRuntimeConfig>,
) {
  if (!options?.agents || typeof options.agents !== "object" || Array.isArray(options.agents) || !Object.keys(options.agents).length) {
    throw new TypeError("[vitehub] subagents({ agents }) requires at least one subagent.")
  }
  const toolNames = new Set<string>()
  return Object.entries(options.agents).map(([name, definition]) => {
    assertSubagentName(name)
    if (!definition?.agent) throw new TypeError(`[vitehub] subagents() "${name}" requires an agent.`)
    if (!definition.description?.trim()) throw new TypeError(`[vitehub] subagents() "${name}" requires a description.`)
    const toolName = toolNameFor(name, definition)
    if (toolNames.has(toolName)) throw new TypeError(`[vitehub] Duplicate subagent tool name "${toolName}". Explicit toolName values disambiguate duplicate subagent tools.`)
    toolNames.add(toolName)
    return { definition, name, toolName }
  })
}

function subagentWorkspaceSources(
  agents: ReturnType<typeof normalizeAgents>,
): WorkspaceDefinition["sources"] | undefined {
  const sources: NonNullable<WorkspaceDefinition["sources"]> = {}
  for (const { definition, name } of agents) {
    const workspaceAgent = definition.agent as Partial<{
      __vitehubWorkspaceAgentOptions: { capabilities?: unknown }
      capabilities: unknown
    }>
    const capabilities = Array.isArray(workspaceAgent.capabilities)
      ? workspaceAgent.capabilities
      : Array.isArray(workspaceAgent.__vitehubWorkspaceAgentOptions?.capabilities)
        ? workspaceAgent.__vitehubWorkspaceAgentOptions.capabilities
        : undefined
    const contributed = capabilityWorkspaceSources(
      capabilities,
    )
    for (const [key, source] of Object.entries(contributed || {})) {
      if (key in sources) {
        throw new Error(`[vitehub] subagents() workspace source "${key}" from "${name}" conflicts with another subagent source.`)
      }
      sources[key] = source
    }
  }
  return Object.keys(sources).length ? sources : undefined
}

function createTool<TRuntimeConfig extends AgentRuntimeConfig>(
  definition: SubagentDefinition<TRuntimeConfig>,
  name: string,
  parentContext: AgentCapabilityContext<TRuntimeConfig>,
): AgentToolDefinition {
  return {
    description: definition.description,
    async execute(input: unknown) {
      const { startAgentInvocation } = await import("../index.ts")
      const runtimeContext = (parentContext.runtimeContext || parentContext) as AgentRuntimeContext<TRuntimeConfig>
      const controller = await startAgentInvocation(
        definition.agent,
        runtimeContext,
        withResolvedAgentInvokerInput(input as AgentRunInput, parentContext.invoker),
      )
      return await awaitAgentInvocationResult(controller)
    },
    inputSchema: inputSchema(definition.description),
    name,
  }
}

export function subagents<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  const TAgents extends Record<string, SubagentDefinition<TRuntimeConfig, any, any>> = Record<string, SubagentDefinition<TRuntimeConfig>>,
>(
  options: SubagentsOptions<TRuntimeConfig, TAgents>,
): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  const id = options.id || "subagents"
  const agents = normalizeAgents(options)
  const workspaceSources = subagentWorkspaceSources(agents)

  return defineCapability({
    id,
    ...(workspaceSources ? { workspaceSources } : {}),
    tools(context) {
      const tools: AgentToolSet = {}
      for (const { definition, toolName } of agents) {
        tools[toolName] = createTool(definition, toolName, context)
      }
      return tools
    },
  })
}
