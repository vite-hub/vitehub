import {
  defineAgent,
  runAgentInline,
} from "./index.ts"
import { resolveAgentUsageRecord } from "./agent-output.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"
import { createTraceEventLog, deriveTraceRuns } from "@vite-hub/runtime"
import { registerWorkspace } from "@vite-hub/workspace/test"

import type {
  AgentErrorHook,
  AgentErrorHookEvent,
  AgentInput,
  AgentFinishEvent,
  AgentFinishHook,
  AgentFinishHookEvent,
  AgentFinishExtensions,
  AgentModelExecutionOptions,
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
import type { WorkspaceName } from "@vite-hub/workspace"
import type { TraceEventLog, TraceRunView } from "@vite-hub/runtime"

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
  extensions?: AgentFinishExtensions
  finishReason?: unknown
  raw: unknown
  text: string
  toolSteps: AgentToolStep[]
  trace?: TraceRunView
  usage?: unknown
  warnings?: unknown
}

export interface AgentTestRunner<CALL_OPTIONS = never> {
  run: (input: AgentRunInput<CALL_OPTIONS>) => Promise<AgentTestRunResult>
}

type AgentToolStepItem = NonNullable<AgentToolStep["toolCalls"]>[number]

let runIdCounter = 0

function isWorkspaceAgentDefinition(value: unknown): value is WorkspaceAgentDefinition {
  return typeof value === "object"
    && value !== null
    && "__vitehubWorkspaceAgent" in value
    && (value as { __vitehubWorkspaceAgent?: unknown }).__vitehubWorkspaceAgent === true
}

function isAgentDefinition(value: unknown): value is AgentInput<AgentRuntimeContext<AgentRuntimeConfig>> & { hooks?: Record<string, unknown> } {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function withTestModelInstrumentation<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  instrumentation: AgentModelInstrumentation<TRuntimeConfig> | undefined,
): AgentInput<AgentRuntimeContext<TRuntimeConfig>> {
  if (!instrumentation || !isWorkspaceAgentDefinition(agent)) {
    return agent
  }

  const workspaceAgent = agent as WorkspaceAgentDefinition<TRuntimeConfig>
  const driver = (workspaceAgent.__vitehubWorkspaceAgentOptions as { driver?: unknown }).driver
  const modelDriver = typeof driver === "object" && driver !== null && "model" in driver
    ? driver as { execution?: AgentModelExecutionOptions<TRuntimeConfig> }
    : undefined
  if (!modelDriver) {
    return agent
  }
  const modelExecution = modelDriver.execution
  const originalInstrumentation = modelExecution?.instrumentation?.model as AgentModelInstrumentation<TRuntimeConfig> | undefined
  const instrumentedExecution = {
    ...modelExecution,
    instrumentation: {
      ...modelExecution?.instrumentation,
      async model(context: Parameters<AgentModelInstrumentation<TRuntimeConfig>>[0]) {
        const model = originalInstrumentation
          ? await originalInstrumentation(context)
          : context.model
        return await instrumentation({
          ...context,
          model,
        })
      },
    },
  }
  const nextOptions = {
    ...workspaceAgent.__vitehubWorkspaceAgentOptions,
    driver: { ...(driver as Record<string, unknown>),
      execution: instrumentedExecution, },
  }
  return defineAgent({
    ...nextOptions,
  } as never) as AgentInput<AgentRuntimeContext<TRuntimeConfig>>
}

function createDefaultRun(name: string | undefined): AgentRunMetadata {
  runIdCounter += 1
  return {
    runId: `${name || "agent"}-test-${runIdCounter}`,
  }
}

function withTestOutcomeCapture<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  capture: (event: AgentFinishEvent<TRuntimeConfig>) => void,
): AgentInput<AgentRuntimeContext<TRuntimeConfig>> {
  if (!isAgentDefinition(agent)) return agent

  const clone = Object.create(Object.getPrototypeOf(agent)) as AgentInput<AgentRuntimeContext<TRuntimeConfig>> & { hooks?: Record<string, unknown> }
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(agent))
  const hooks = clone.hooks || {}
  const errorHook = hooks["agent:error"] as AgentErrorHook<TRuntimeConfig> | undefined
  const finishHook = hooks["agent:finish"] as AgentFinishHook<TRuntimeConfig> | undefined
  clone.hooks = {
    ...hooks,
    async "agent:error"(event: AgentErrorHookEvent<TRuntimeConfig>) {
      capture(event)
      return await errorHook?.(event)
    },
    async "agent:finish"(event: AgentFinishHookEvent<TRuntimeConfig>) {
      capture(event)
      return await finishHook?.(event)
    },
  }
  return clone
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

function countWorkspaceInspectionGuardrails(step: AgentToolStep): number {
  return (step.toolResults || []).filter((result) => {
    if (result.toolName !== "shell" && result.toolName !== "materialize_sources") {
      return false
    }
    return hasWorkspaceGuardrail(result.output)
  }).length
}

function hasWorkspaceGuardrail(output: unknown): boolean {
  return typeof output === "object"
    && output !== null
    && typeof (output as { workspaceGuardrail?: { kind?: unknown } }).workspaceGuardrail?.kind === "string"
}

function stringifyToolOutput(output: unknown): string {
  try {
    return JSON.stringify(output) ?? String(output)
  }
  catch {
    return String(output)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value) return value
  }
}

function readValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key]
  }
}

function readToolName(record: Record<string, unknown>, toolNames: Map<string, string>): string | undefined {
  const id = readString(record, "toolCallId", "id")
  const name = readString(record, "toolName", "name") ?? (id ? toolNames.get(id) : undefined)
  if (!name) return
  const normalized = name === "bash" ? "shell" : name
  if (id) toolNames.set(id, normalized)
  return normalized
}

function appendToolStepItem(items: AgentToolStepItem[], value: unknown, toolNames: Map<string, string>) {
  if (!isRecord(value)) return
  const toolName = readToolName(value, toolNames)
  if (!toolName) return
  const input = readValue(value, "input", "args")
  const output = readValue(value, "output", "result")
  const toolCallId = readString(value, "toolCallId", "id")
  items.push({
    ...(toolCallId ? { toolCallId } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    toolName,
  })
}

function appendToolStepItems(items: AgentToolStepItem[], value: unknown, toolNames: Map<string, string>) {
  if (!Array.isArray(value)) return
  for (const item of value) appendToolStepItem(items, item, toolNames)
}

function toolStepFromRawStep(value: unknown, toolNames: Map<string, string>): AgentToolStep | undefined {
  if (!isRecord(value)) return
  const toolCalls: AgentToolStepItem[] = []
  const toolErrors: AgentToolStepItem[] = []
  const toolResults: AgentToolStepItem[] = []
  appendToolStepItems(toolCalls, value.toolCalls, toolNames)
  appendToolStepItems(toolErrors, value.toolErrors, toolNames)
  appendToolStepItems(toolResults, value.toolResults, toolNames)

  const parts = Array.isArray(value.content) ? value.content : [value]
  for (const part of parts) {
    if (!isRecord(part)) continue
    const type = String(part.type || "")
    if (type === "tool-call" || type === "tool-input-available" || type === "tool-input-start") {
      appendToolStepItem(toolCalls, part, toolNames)
    }
    else if (type === "tool-error" || type === "tool-output-error") {
      appendToolStepItem(toolErrors, part, toolNames)
    }
    else if (type === "tool-result" || type === "tool-output-available") {
      appendToolStepItem(toolResults, part, toolNames)
    }
  }

  return toolCalls.length || toolErrors.length || toolResults.length
    ? {
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(toolErrors.length ? { toolErrors } : {}),
        ...(toolResults.length ? { toolResults } : {}),
      }
    : undefined
}

function toolStepsFromRaw(value: unknown): AgentToolStep[] {
  const toolSteps: AgentToolStep[] = []
  const toolNames = new Map<string, string>()
  const seen = new Set<unknown>()
  const collect = (source: unknown) => {
    if (!isRecord(source) || seen.has(source)) return
    seen.add(source)
    if (Array.isArray(source.steps)) {
      for (const step of source.steps) {
        const toolStep = toolStepFromRawStep(step, toolNames)
        if (toolStep) toolSteps.push(toolStep)
      }
    }
    collect(source.raw)
  }
  collect(value)
  return toolSteps
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

async function normalizeAgentTestResult(
  value: unknown,
  toolSteps: AgentToolStep[],
  getFinishEvent: () => AgentFinishEvent | undefined,
  getTrace: () => TraceRunView | undefined,
): Promise<AgentTestRunResult> {
  if (value instanceof Response) {
    const text = await value.clone().text()
    const finishEvent = getFinishEvent()
    const trace = getTrace()
    const usage = await normalizedTestUsage(value, finishEvent)
    return {
      ...(finishEvent?.extensions ? { extensions: finishEvent.extensions } : {}),
      ...(trace ? { trace } : {}),
      ...(usage ? { usage } : {}),
      raw: value,
      text,
      toolSteps,
    }
  }

  const result = typeof value === "object" && value !== null
    ? value as AgentRunResult
    : undefined
  const finishEvent = getFinishEvent()
  const trace = getTrace()
  const usage = await normalizedTestUsage(value, finishEvent)

  return {
    ...(finishEvent?.extensions ? { extensions: finishEvent.extensions } : {}),
    finishReason: result?.finishReason,
    raw: value,
    text: textFromRaw(value),
    toolSteps: [...toolSteps, ...toolStepsFromRaw(value)],
    ...(trace ? { trace } : {}),
    usage: usage ?? result?.usage,
    warnings: result?.warnings,
  }
}

async function normalizedTestUsage(value: unknown, event: AgentFinishEvent | undefined) {
  return event?.invocation.usage?.usage ?? (await resolveAgentUsageRecord(value, event?.invocation.run))?.usage
}

function completedTraceRun(traceLog: TraceEventLog, run: AgentRunMetadata | undefined): TraceRunView | undefined {
  const runs = deriveTraceRuns(traceLog.entries())
  const trace = run?.runId ? runs.find(item => item.id === run.runId) : runs.length === 1 ? runs[0] : undefined
  return trace?.status === "running" ? undefined : trace
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

  const instrumentedAgent = withTestModelInstrumentation(agent, options.instrumentModel)
  const identityName = options.name || options.workspace

  return {
    async run(input) {
      const toolSteps: AgentToolStep[] = []
      let workspaceInspectionGuardrails = 0
      let finishEvent: AgentFinishEvent | undefined
      const run = await resolveRun(options.name, options.run)
      const traceLog = createTraceEventLog()
      const context = createAgentRuntimeContext({
        ...(identityName
          ? { agentIdentity: { name: identityName, ...(options.workspace ? { workspace: options.workspace } : {}) } }
          : {}),
        toolStepReporter(step) {
          toolSteps.push(step)
          if (process.env.VITEHUB_AGENT_TEST_DEBUG_TOOLS) {
            console.error("[vitehub-agent-test:tool]", stringifyToolOutput(step))
          }
          if (options.workspace) {
            workspaceInspectionGuardrails += countWorkspaceInspectionGuardrails(step)
            if (workspaceInspectionGuardrails >= 4) {
              throw new Error("[vitehub] Agent stopped after repeated workspace inspection guardrails. The requested evidence appears unavailable in the mounted workspace sources.")
            }
          }
        },
        request: options.request,
        run,
        runtime: options.runtime || (options.workspace || isWorkspaceAgentDefinition(agent) ? "vite" : "unknown"),
        runtimeConfig: await resolveRuntimeConfig(options.runtimeConfig),
        traceLog,
        waitUntil: options.waitUntil || createWaitUntil(),
      })

      const raw = await runAgentInline<TRuntimeConfig, CALL_OPTIONS>(
        withTestOutcomeCapture(instrumentedAgent, value => {
          finishEvent = value as AgentFinishEvent
        }),
        context,
        input,
      )
      return await normalizeAgentTestResult(raw, toolSteps, () => finishEvent, () => completedTraceRun(traceLog, run))
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
