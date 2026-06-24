import { capabilityWorkspaceSources, defineCapability } from "../capability-runtime.ts"
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

interface JsonSchema {
  additionalProperties?: boolean | JsonSchema
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  type?: string
}

export interface SubagentToolInput<
  CALL_OPTIONS = unknown,
  TContext extends object = Record<string, unknown>,
> {
  context?: TContext
  message: string | Message
  options?: CALL_OPTIONS
  runId?: string
  timeout?: number
}

export interface SubagentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
  TContext extends object = Record<string, unknown>,
> {
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>
  description: string
  instructions?: string
  toolName?: string
}

export interface SubagentsOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TAgents extends Record<string, SubagentDefinition<TRuntimeConfig, any, any>> = Record<string, SubagentDefinition<TRuntimeConfig>>,
> {
  agents: TAgents
  id?: string
  instructions?: string | false
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

function inputSchema(description: string): JsonSchema {
  return {
    additionalProperties: false,
    properties: {
      context: { additionalProperties: true, description: "Structured task context for the subagent.", type: "object" },
      message: { description, type: "string" },
      options: { additionalProperties: true, description: "Agent call options for the subagent.", type: "object" },
      runId: { description: "Optional run id for this subagent invocation.", type: "string" },
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

function renderInstructions(agents: ReturnType<typeof normalizeAgents>, fallback?: string | false): string | false {
  if (fallback === false) return false
  return fallback || [
    "Use subagents for bounded delegated work. Call the matching subagent tool with a clear message and structured context.",
    "",
    ...agents.map(({ definition, name, toolName }) => [
      `- ${name}: ${definition.description} Tool: ${toolName}.`,
      definition.instructions ? `  Instructions: ${definition.instructions}` : "",
    ].filter(Boolean).join("\n")),
  ].join("\n")
}

function subagentWorkspaceSources(
  agents: ReturnType<typeof normalizeAgents>,
): WorkspaceDefinition["sources"] | undefined {
  const sources: NonNullable<WorkspaceDefinition["sources"]> = {}
  for (const { definition, name } of agents) {
    const workspaceAgent = definition.agent as Partial<{
      __vitehubWorkspaceAgentOptions: { capabilities?: AgentCapabilityDefinition[] }
      capabilities: AgentCapabilityDefinition[]
    }>
    const contributed = capabilityWorkspaceSources(
      workspaceAgent.__vitehubWorkspaceAgentOptions?.capabilities || workspaceAgent.capabilities,
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

function randomToken(): string {
  return globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
}

function childRunId(parentRunId: string | undefined, name: string, runId: string | undefined): string | undefined {
  return runId || (parentRunId ? `${parentRunId}:${name}:${randomToken()}` : undefined)
}

function createTool<TRuntimeConfig extends AgentRuntimeConfig>(
  definition: SubagentDefinition<TRuntimeConfig>,
  name: string,
  parentContext: AgentCapabilityContext<TRuntimeConfig>,
): AgentToolDefinition {
  return {
    description: definition.description,
    async execute(input: unknown) {
      const { runAgent } = await import("../index.ts")
      const { runId, ...agentInput } = input as SubagentToolInput
      const runtimeContext = (parentContext.runtimeContext || parentContext) as AgentRuntimeContext<TRuntimeConfig>
      const nextRunId = childRunId(runtimeContext.run?.runId, name, runId)
      return await runAgent(definition.agent, nextRunId
        ? { ...runtimeContext, run: { ...runtimeContext.run, runId: nextRunId } }
        : runtimeContext, withResolvedAgentInvokerInput(agentInput as AgentRunInput, parentContext.invoker))
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
  const instructions = renderInstructions(agents, options.instructions)
  const workspaceSources = subagentWorkspaceSources(agents)

  return defineCapability({
    id,
    instructions,
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
