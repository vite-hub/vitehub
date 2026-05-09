import { generateText, stepCountIs, ToolLoopAgent } from "ai"
import { useWorkspace } from "@vitehub/workspace"

import { defineAgent } from "./index.ts"

import type { ToolLoopAgentSettings, ToolSet } from "ai"
import type {
  AgentRunInput,
  AgentDefinition,
  AgentRuntimeConfig,
  AgentRunContext,
  MaybePromise,
  ResolvedAgentRuntimeContext,
} from "./types.ts"
import type {
  ReadonlyWorkspaceFacade,
  WorkspaceFacadeToolOptions,
  WorkspaceName,
} from "@vitehub/workspace"

type WorkspaceRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig> =
  ResolvedAgentRuntimeContext<TRuntimeConfig>

type WorkspaceModel<TRuntimeConfig extends AgentRuntimeConfig> =
  | ToolLoopAgentSettings["model"]
  | ((context: WorkspaceRuntimeContext<TRuntimeConfig>) => MaybePromise<ToolLoopAgentSettings["model"]>)

export interface WorkspaceAgentFallbackOptions {
  enabled?: boolean
  maxToolResults?: number
}

export interface WorkspaceAgentOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  description?: string
  fallback?: boolean | WorkspaceAgentFallbackOptions
  instructions?: string
  instructionsFile?: boolean | string
  model: WorkspaceModel<TRuntimeConfig>
  stepLimit?: number
  toolOptions?: WorkspaceFacadeToolOptions
  workspace: WorkspaceName
}

function isModelResolver<TRuntimeConfig extends AgentRuntimeConfig>(
  model: WorkspaceModel<TRuntimeConfig>,
): model is (context: WorkspaceRuntimeContext<TRuntimeConfig>) => MaybePromise<ToolLoopAgentSettings["model"]> {
  return typeof model === "function"
}

async function resolveModel<TRuntimeConfig extends AgentRuntimeConfig>(
  model: WorkspaceModel<TRuntimeConfig>,
  context: WorkspaceRuntimeContext<TRuntimeConfig>,
) {
  return isModelResolver(model) ? await model(context) : model
}

function getPromptText(input: AgentRunInput) {
  if (typeof input.prompt === "string") return input.prompt

  const messages = input.messages || (Array.isArray(input.prompt) ? input.prompt : [])
  const latestUserMessage = [...messages].reverse().find(message => message.role === "user")

  if (!latestUserMessage) return ""
  if (typeof latestUserMessage.content === "string") return latestUserMessage.content

  return latestUserMessage.content
    .map((part) => {
      if (part.type === "text") return part.text
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function getAgentCall(input: AgentRunInput) {
  if (input.messages) return { messages: input.messages }
  if (input.prompt) return { prompt: input.prompt }
  return { messages: [] }
}

async function readInstructionsFile(
  workspace: ReadonlyWorkspaceFacade,
  path: boolean | string | undefined,
) {
  if (!path) return undefined
  const filePath = path === true ? "AGENTS.md" : path

  try {
    return await workspace.fs.readFile(filePath, { encoding: "utf8" })
  }
  catch {
    return undefined
  }
}

function joinInstructions(...parts: Array<string | undefined>) {
  return parts
    .map(part => part?.trim())
    .filter(Boolean)
    .join("\n\n")
}

function getFallbackOptions(fallback: WorkspaceAgentOptions["fallback"]): Required<WorkspaceAgentFallbackOptions> {
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

async function synthesizeFallback<TRuntimeConfig extends AgentRuntimeConfig>(
  model: ToolLoopAgentSettings["model"],
  context: AgentRunContext<TRuntimeConfig>,
  result: { steps?: Array<{ content?: Array<{ type: string, output?: unknown }> }> },
  maxToolResults: number,
) {
  const evidence = collectToolResults(result, maxToolResults)
  if (evidence.length === 0) return undefined

  const summary = await generateText({
    model,
    system: [
      "Answer the user's last message using only the workspace tool results.",
      "If the tool results are insufficient, say what is missing.",
    ].join("\n"),
    prompt: [
      `User message:\n${getPromptText(context.input)}`,
      `Workspace tool results:\n${evidence.join("\n\n---\n\n")}`,
    ].join("\n\n"),
  })

  return summary.text.trim() || undefined
}

export function defineWorkspaceAgent<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: WorkspaceAgentOptions<TRuntimeConfig>,
): AgentDefinition<TRuntimeConfig, never, ToolSet> {
  return defineAgent<TRuntimeConfig, never, ToolSet>({
    description: options.description,
    async run(context) {
      const workspace = useWorkspace(options.workspace)
      const model = await resolveModel(options.model, context)
      const instructionsFromFile = await readInstructionsFile(workspace, options.instructionsFile)
      const instructions = joinInstructions(options.instructions, instructionsFromFile)
      const agent = new ToolLoopAgent({
        instructions,
        model,
        stopWhen: stepCountIs(options.stepLimit ?? 20),
        tools: workspace.tools(options.toolOptions),
      })
      const result = await agent.generate({
        ...getAgentCall(context.input),
        abortSignal: context.input.abortSignal,
        timeout: context.input.timeout,
      })
      const text = result.text.trim()

      if (text) return text

      const fallback = getFallbackOptions(options.fallback)
      if (fallback.enabled && result.finishReason === "tool-calls") {
        const synthesized = await synthesizeFallback(model, context, result, fallback.maxToolResults)
        if (synthesized) return synthesized
      }

      return result
    },
  })
}
