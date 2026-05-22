import {
  defineAgent,
  runAgent,
  withWorkspaceAgentDefaults,
} from "./index.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"
import { registerWorkspace } from "@vitehub/workspace"

import type {
  AgentAdapter,
  AgentAdapterRunContext,
  AgentAdapterResult,
  AgentInput,
  AgentModelInstrumentation,
  AgentRunInput,
  AgentRunMetadata,
  AgentRunResult,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeName,
  AgentToolStep,
  AgentWaitUntil,
  MaybePromise,
  WorkspaceAgentDefinition,
} from "./index.ts"
import type { StreamEvent } from "./messages.ts"
import type { WorkspaceName } from "@vitehub/workspace"

export { createAgentRuntimeContext }

export interface AgentTestRunnerOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  instrumentModel?: AgentModelInstrumentation<TRuntimeConfig>
  name?: string
  request?: Request
  run?: AgentRunMetadata | (() => MaybePromise<AgentRunMetadata | undefined>)
  runtime?: AgentRuntimeName
  runtimeConfig: TRuntimeConfig | (() => MaybePromise<TRuntimeConfig>)
  waitUntil?: AgentWaitUntil
  workspace?: WorkspaceName
}

export interface AgentTestRunResult {
  finishReason?: unknown
  raw: unknown
  text: string
  toolSteps: AgentToolStep[]
  usage?: unknown
  warnings?: unknown
}

export interface AgentTestRunner<CALL_OPTIONS = never> {
  run: (input: AgentRunInput<CALL_OPTIONS>) => Promise<AgentTestRunResult>
}

export interface MockAgentToolStep {
  delay?: number
  id?: string
  input?: unknown
  name: string
  output?: unknown
  text?: string
}

interface MockAgentToolStepItem {
  input?: unknown
  output?: unknown
  toolCallId: string
  toolName: string
}

export interface MockAgentAdapterOptions<CALL_OPTIONS = never> {
  delay?: number
  name?: string
  reply?: string | ((context: AgentAdapterRunContext<CALL_OPTIONS>) => MaybePromise<string | AgentAdapterResult>)
  tools?: MockAgentToolStep[]
}

let runIdCounter = 0

function wait(ms: number | undefined): Promise<void> {
  return ms && ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

function latestUserText(input: AgentRunInput): string {
  if (typeof input.prompt === "string") return input.prompt
  const latest = input.messages?.filter(message => message.role === "user").at(-1)
  return latest?.parts
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("") || ""
}

function defaultMockReply(context: AgentAdapterRunContext): string {
  const text = latestUserText(context.input)
  return [
    text ? `I inspected the deterministic playground context for "${text}".` : "I inspected the deterministic playground context.",
    "The mocked tools returned workspace metadata, so this reply is generated without calling a model provider.",
  ].join(" ")
}

function toToolStepItem(tool: MockAgentToolStep): MockAgentToolStepItem {
  return {
    input: tool.input,
    output: tool.output,
    toolCallId: tool.id || tool.name,
    toolName: tool.name,
  }
}

async function resolveMockReply<CALL_OPTIONS>(
  context: AgentAdapterRunContext<CALL_OPTIONS>,
  reply: MockAgentAdapterOptions<CALL_OPTIONS>["reply"],
): Promise<AgentAdapterResult> {
  const value = typeof reply === "function"
    ? await reply(context)
    : reply || defaultMockReply(context)
  return typeof value === "string" ? { finishReason: "stop", text: value } : value
}

async function runMockTools<CALL_OPTIONS>(
  context: AgentAdapterRunContext<CALL_OPTIONS>,
  options: MockAgentAdapterOptions<CALL_OPTIONS>,
): Promise<void> {
  for (const tool of options.tools || []) {
    const item = toToolStepItem(tool)
    await context.devtools?.reportToolStep?.({ toolCalls: [item] })
    await wait(tool.delay ?? options.delay)
    await context.devtools?.reportToolStep?.({ toolResults: [item] })
  }
}

async function* streamMockAgent<CALL_OPTIONS>(
  context: AgentAdapterRunContext<CALL_OPTIONS>,
  options: MockAgentAdapterOptions<CALL_OPTIONS>,
): AsyncIterable<StreamEvent> {
  for (const tool of options.tools || []) {
    const id = tool.id || tool.name
    yield { id, input: tool.input, name: tool.name, type: "tool-call" }
    await wait(tool.delay ?? options.delay)
    yield { id, name: tool.name, output: tool.output, type: "tool-result" }
  }

  const result = await resolveMockReply(context, options.reply)
  await wait(options.delay)
  if (result.text) {
    yield { text: result.text, type: "text-delta" }
  }
  yield { reason: typeof result.finishReason === "string" ? result.finishReason : "stop", type: "finish" }
}

export function createMockAgentAdapter<CALL_OPTIONS = never>(
  options: MockAgentAdapterOptions<CALL_OPTIONS> = {},
): AgentAdapter<CALL_OPTIONS> {
  return {
    name: options.name || "mock",
    async generate(context) {
      await runMockTools(context as never, options)
      return await resolveMockReply(context as never, options.reply)
    },
    async stream(context) {
      return streamMockAgent(context as never, options)
    },
  }
}

function isWorkspaceAgentDefinition(value: unknown): value is WorkspaceAgentDefinition {
  return typeof value === "object"
    && value !== null
    && "__vitehubWorkspaceAgent" in value
    && (value as { __vitehubWorkspaceAgent?: unknown }).__vitehubWorkspaceAgent === true
}

function withTestModelInstrumentation<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  instrumentation: AgentModelInstrumentation<TRuntimeConfig> | undefined,
): AgentInput<AgentRuntimeContext<TRuntimeConfig>> {
  if (!instrumentation || !isWorkspaceAgentDefinition(agent)) {
    return agent
  }

  const workspaceAgent = agent as WorkspaceAgentDefinition<TRuntimeConfig>
  const originalInstrumentation = workspaceAgent.__vitehubWorkspaceAgentOptions.instrumentModel as AgentModelInstrumentation<TRuntimeConfig> | undefined
  return defineAgent({
    ...workspaceAgent.__vitehubWorkspaceAgentOptions,
    async instrumentModel(context: Parameters<AgentModelInstrumentation<TRuntimeConfig>>[0]) {
      const model = originalInstrumentation
        ? await originalInstrumentation(context)
        : context.model
      return await instrumentation({
        ...context,
        model,
      })
    },
  }) as AgentInput<AgentRuntimeContext<TRuntimeConfig>>
}

function createDefaultRun(name: string | undefined): AgentRunMetadata {
  runIdCounter += 1
  return {
    runId: `${name || "agent"}-test-${runIdCounter}`,
  }
}

async function resolveRun(
  name: string | undefined,
  run: AgentTestRunnerOptions["run"],
): Promise<AgentRunMetadata | undefined> {
  if (typeof run === "function") {
    return await run()
  }
  return run || createDefaultRun(name)
}

async function resolveRuntimeConfig<TRuntimeConfig extends AgentRuntimeConfig>(
  runtimeConfig: AgentTestRunnerOptions<TRuntimeConfig>["runtimeConfig"],
): Promise<TRuntimeConfig> {
  return typeof runtimeConfig === "function"
    ? await runtimeConfig()
    : runtimeConfig
}

function createWaitUntil(): AgentWaitUntil {
  return (task) => {
    void task
  }
}

function textFromRaw(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  if (typeof value === "object" && value !== null && "text" in value) {
    const text = (value as { text?: unknown }).text
    return typeof text === "string" ? text : ""
  }
  return ""
}

async function normalizeAgentTestResult(value: unknown, toolSteps: AgentToolStep[]): Promise<AgentTestRunResult> {
  if (value instanceof Response) {
    const text = await value.clone().text()
    return {
      raw: value,
      text,
      toolSteps,
    }
  }

  const result = typeof value === "object" && value !== null
    ? value as AgentRunResult
    : undefined

  return {
    finishReason: result?.finishReason,
    raw: value,
    text: textFromRaw(value),
    toolSteps,
    usage: result?.usage,
    warnings: result?.warnings,
  }
}

export function createAgentTestRunner<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  options: AgentTestRunnerOptions<TRuntimeConfig>,
): AgentTestRunner<CALL_OPTIONS> {
  if (options.workspace && isWorkspaceAgentDefinition(agent)) {
    registerWorkspace(options.workspace, agent)
  }

  const preparedAgent = options.workspace
    ? withWorkspaceAgentDefaults(
        withTestModelInstrumentation(agent, options.instrumentModel) as WorkspaceAgentDefinition<TRuntimeConfig>,
        { name: options.name, workspace: options.workspace },
      )
    : withTestModelInstrumentation(agent, options.instrumentModel)

  return {
    async run(input) {
      const toolSteps: AgentToolStep[] = []
      const context = createAgentRuntimeContext({
        devtools: {
          reportToolStep(step) {
            toolSteps.push(step)
          },
        },
        request: options.request,
        run: await resolveRun(options.name, options.run),
        runtime: options.runtime || "unknown",
        runtimeConfig: await resolveRuntimeConfig(options.runtimeConfig),
        waitUntil: options.waitUntil || createWaitUntil(),
      })

      const raw = await runAgent<TRuntimeConfig, CALL_OPTIONS>(
        preparedAgent,
        context,
        input,
      )
      return await normalizeAgentTestResult(raw, toolSteps)
    },
  }
}

export async function runAgentForTest<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  options: AgentTestRunnerOptions<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
): Promise<AgentTestRunResult> {
  return await createAgentTestRunner<TRuntimeConfig, CALL_OPTIONS>(agent, options).run(input)
}
