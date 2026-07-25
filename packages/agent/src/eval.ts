import { statSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { evalite } from "evalite"

import {
  defineAgent,
  type AgentFinishExtensions,
  type AgentInput,
  type AgentModelInput,
  type AgentRunInput,
  type AgentRuntimeContext,
  type AgentRuntimeConfig,
  type AgentSettings,
  type AgentToolStep,
  type MaybePromise,
  type WorkspaceAgentDefinition,
  type WorkspaceAgentOptions,
} from "./index.ts"
import {
  createAgentTestRunner,
  type AgentTestRunResult,
} from "./test.ts"
import {
  createMessage,
  type Message,
} from "./messages.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import type { TraceRunView } from "@vite-hub/runtime"

export interface AgentScore {
  metadata?: unknown
  passed?: boolean
  reason?: string
  score: number
}

export interface AgentObservation {
  extensions?: AgentFinishExtensions
  finishReason?: unknown
  metadata?: unknown
  raw: unknown
  scenario: string
  text: string
  toolSteps: AgentToolStep[]
  trace?: TraceRunView
  usage?: unknown
  variant: string
  warnings?: unknown
}

export interface AgentScorer {
  description?: string
  name: string
  score: (observation: AgentObservation) => MaybePromise<AgentScore>
}

export interface AgentEvalScenario<CALL_OPTIONS = never> {
  input: AgentRunInput<CALL_OPTIONS>
  metadata?: unknown
  name: string
  scorers?: AgentScorer[]
}

export interface AgentEvalVariant {
  instructions?: string | string[]
  model?: AgentModelInput
  name: string
}

export interface AgentEvalTestContext<CALL_OPTIONS = never> {
  readonly observation?: AgentObservation
  readonly reply: string
  calledTool: (name: string) => void
  capabilityExtension: {
    <T = unknown>(capabilityId: string): T | undefined
    <T = unknown>(capabilityId: string, key: string): T | undefined
  }
  completed: () => void
  doesNotCallTool: (name: string) => void
  hasCapabilityExtension: (capabilityId: string, key?: string) => void
  expect: (scorer: AgentScorer) => void
  send: (input: string | AgentRunInput<CALL_OPTIONS>) => Promise<AgentObservation>
  textContains: (expected: string | RegExp) => void
}

export type AgentEvalTest<CALL_OPTIONS = never> = (context: AgentEvalTestContext<CALL_OPTIONS>) => MaybePromise<void>

interface AgentEvalBaseDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
> {
  agent?: AgentEvalAgent<TRuntimeConfig> | (() => MaybePromise<AgentEvalAgent<TRuntimeConfig>>)
  name?: string
  runtimeConfig?: TRuntimeConfig | (() => MaybePromise<TRuntimeConfig>)
  scorers?: AgentScorer[]
  variants?: AgentEvalVariant[]
  workspace?: WorkspaceName
}

export type AgentEvalDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
> = AgentEvalBaseDefinition<TRuntimeConfig, CALL_OPTIONS> & (
  | {
    scenarios: Array<AgentEvalScenario<CALL_OPTIONS>>
    test?: never
  }
  | {
    scenarios?: never
    test: AgentEvalTest<CALL_OPTIONS>
  }
)

type AgentEvalAgent<TRuntimeConfig extends AgentRuntimeConfig> = AgentInput<AgentRuntimeContext<TRuntimeConfig>>

interface NormalizedEvalScenario<CALL_OPTIONS> extends AgentEvalScenario<CALL_OPTIONS> {
  kind: "scenario"
  scorers: AgentScorer[]
}

interface NormalizedEvalTest<CALL_OPTIONS> {
  kind: "test"
  metadata?: unknown
  name: string
  scorers: AgentScorer[]
  test: AgentEvalTest<CALL_OPTIONS>
}

type NormalizedEvalCase<CALL_OPTIONS> =
  | NormalizedEvalScenario<CALL_OPTIONS>
  | NormalizedEvalTest<CALL_OPTIONS>

interface AgentEvalInput<CALL_OPTIONS> {
  scenario: NormalizedEvalCase<CALL_OPTIONS>
  variant: AgentEvalVariant
}

interface AgentObservationWithScores extends AgentObservation {
  scores: AgentScore[]
}

const baselineVariant: AgentEvalVariant = { name: "baseline" }

function isWorkspaceAgentDefinition(value: unknown): value is WorkspaceAgentDefinition {
  return typeof value === "object"
    && value !== null
    && "__vitehubWorkspaceAgent" in value
    && (value as { __vitehubWorkspaceAgent?: unknown }).__vitehubWorkspaceAgent === true
}

function isVariantOverride(variant: AgentEvalVariant): boolean {
  return variant.instructions !== undefined || variant.model !== undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function variantModelDriver(
  variant: AgentEvalVariant,
  output?: unknown,
): Record<string, unknown> {
  return {
    ...(variant.instructions !== undefined ? { instructions: variant.instructions } : {}),
    model: variant.model,
    ...(output !== undefined ? { output } : {}),
  }
}

function applyVariantToExplicitDriver(
  driver: unknown,
  variant: AgentEvalVariant,
): Record<string, unknown> {
  if (!isRecord(driver)) {
    throw new Error("[vitehub] Agent Evaluation variants with model or instructions require a model-backed Agent Driver.")
  }
  if ("model" in driver) {
    return {
      ...driver,
      ...(variant.instructions !== undefined ? { instructions: variant.instructions } : {}),
      ...(variant.model !== undefined ? { model: variant.model as never } : {}),
    }
  }
  if ("harness" in driver && variant.model !== undefined) {
    return variantModelDriver(variant, driver.output)
  }
  throw new Error("[vitehub] Agent Evaluation variants with model or instructions require a model-backed Agent Driver.")
}

function resolveEvalNameFromFile(caller: string): string {
  const base = basename(caller, extname(caller))
  if (base === "eval") return basename(dirname(caller))
  return base.endsWith(".eval") ? base.slice(0, -".eval".length) : base
}

function getCallerFile(): string | undefined {
  const stack = new Error().stack
  if (!stack) return
  const current = fileURLToPath(import.meta.url)
  const sourceMappedCurrent = sourceMappedEvalFile(current)
  for (const line of stack.split("\n")) {
    if (line.includes("getCallerFile") || line.includes("defineEval")) continue
    const stackPath = parseStackFramePath(line)
    if (!stackPath) continue
    const file = stackPath.startsWith("file://") ? fileURLToPath(stackPath) : stackPath
    if (file !== current && file !== sourceMappedCurrent) return file
  }
}

function parseStackFramePath(line: string): string | undefined {
  const match = line.match(/\(((?:file:\/\/)?.+?\.(?:c|m)?[jt]s)(?::\d+:\d+)?\)$/)
    || line.match(/^\s*at\s+(?:async\s+)?((?:file:\/\/)?.+?\.(?:c|m)?[jt]s)(?::\d+:\d+)?$/)
  return match?.[1]
}

export function sourceMappedEvalFile(current: string): string {
  return current.replace(/([/\\])dist[/\\]eval\.js$/, "$1src$1eval.ts")
}

async function resolveSiblingAgent<TRuntimeConfig extends AgentRuntimeConfig>(
  caller: string | undefined,
): Promise<AgentEvalAgent<TRuntimeConfig>> {
  if (!caller) {
    throw new Error("[vitehub] defineEval() could not infer the sibling Agent Definition. The sibling Agent Definition must be passed explicitly.")
  }

  const extension = extname(caller)
  const base = basename(caller, extension)
  const sibling = base === "eval"
    ? join(dirname(caller), `agent${extension}`)
    : caller.slice(0, -extension.length).replace(/\.eval$/, "") + extension
  const module = await import(pathToFileURL(sibling).href) as { default?: AgentEvalAgent<TRuntimeConfig> }
  if (!module.default) {
    throw new Error(`[vitehub] defineEval() expected ${sibling} to default export an Agent Definition.`)
  }
  return withSiblingWorkspaceSourceRoot(module.default, sibling)
}

function inferWorkspaceSourceRoot(agentFile: string) {
  const directory = dirname(agentFile)
  const workspaceDirectory = resolve(directory, "workspace")
  try {
    return statSync(workspaceDirectory).isDirectory() ? workspaceDirectory : directory
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return directory
    throw error
  }
}

function withSiblingWorkspaceSourceRoot<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentEvalAgent<TRuntimeConfig>,
  agentFile: string,
): AgentEvalAgent<TRuntimeConfig> {
  if (!isWorkspaceAgentDefinition(agent)) return agent

  const options = agent.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<TRuntimeConfig>
  if (typeof options.workspace !== "object" || !options.workspace) return agent
  if ("name" in options.workspace) return agent
  if (options.workspace.sourceRootDir) return agent

  return defineAgent({
    ...options,
    workspace: {
      ...options.workspace,
      sourceRootDir: inferWorkspaceSourceRoot(agentFile),
    },
  })
}

async function resolveEvalAgent<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentEvalDefinition<TRuntimeConfig>["agent"],
  caller: string | undefined,
): Promise<AgentEvalAgent<TRuntimeConfig>> {
  if (!agent) return await resolveSiblingAgent(caller)
  return typeof agent === "function" ? await agent() : agent
}

function applyVariant<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentEvalAgent<TRuntimeConfig>,
  variant: AgentEvalVariant,
): AgentEvalAgent<TRuntimeConfig> {
  if (!isVariantOverride(variant)) return agent
  const settings = (agent as { __vitehubAgentSettings?: AgentSettings<TRuntimeConfig> }).__vitehubAgentSettings
  if (settings) {
    return defineAgent({
      ...settings,
      driver: applyVariantToExplicitDriver(settings.driver, variant) as never,
    } as never)
  }
  if (!isWorkspaceAgentDefinition(agent)) {
    throw new Error("[vitehub] Agent Evaluation variants with model or instructions require an Agent Definition created with defineAgent(...).")
  }

  const options = agent.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<TRuntimeConfig>
  const driver = (options as { driver?: unknown }).driver
  return defineAgent({
    ...options,
    driver: applyVariantToExplicitDriver(driver, variant) as never,
  } as never)
}

function normalizeScenarios<CALL_OPTIONS>(
  scenarios: Array<AgentEvalScenario<CALL_OPTIONS>>,
  scorers: AgentScorer[] | undefined,
): Array<NormalizedEvalScenario<CALL_OPTIONS>> {
  if (!scenarios.length) {
    throw new Error("[vitehub] defineEval({ scenarios }) requires at least one scenario.")
  }
  const globalScorers = scorers || []
  return scenarios.map(scenario => ({
    ...scenario,
    kind: "scenario",
    scorers: [...globalScorers, ...(scenario.scorers || [])],
  }))
}

function normalizeEvalCases<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentEvalDefinition<TRuntimeConfig, CALL_OPTIONS>,
  name: string,
): Array<NormalizedEvalCase<CALL_OPTIONS>> {
  if (definition.scenarios !== undefined) {
    return normalizeScenarios(definition.scenarios, definition.scorers)
  }
  if (definition.test) {
    return [{
      kind: "test",
      name,
      scorers: definition.scorers || [],
      test: definition.test,
    }]
  }
  throw new Error("[vitehub] defineEval() requires scenarios or test.")
}

function normalizeVariants(variants: AgentEvalVariant[] | undefined): AgentEvalVariant[] {
  return variants?.length ? variants : [baselineVariant]
}

function normalizeScore(score: AgentScore): AgentScore {
  const normalizedScore = Number.isFinite(score.score) ? score.score : 0
  return {
    ...score,
    score: Math.max(0, Math.min(1, normalizedScore)),
  }
}

async function scoreObservation(observation: AgentObservation, scorers: AgentScorer[]): Promise<AgentScore[]> {
  return await Promise.all(scorers.map(async (scorer) => {
    const score = await scorer.score(observation)
    return normalizeScore({
      ...score,
      metadata: {
        ...(typeof score.metadata === "object" && score.metadata !== null ? score.metadata as Record<string, unknown> : {}),
        scorer: scorer.name,
      },
    })
  }))
}

function toObservation(result: AgentTestRunResult, scenario: { metadata?: unknown, name: string }, variant: AgentEvalVariant): AgentObservation {
  return {
    ...(result.extensions ? { extensions: result.extensions } : {}),
    finishReason: result.finishReason,
    metadata: scenario.metadata,
    raw: result.raw,
    scenario: scenario.name,
    text: result.text,
    toolSteps: result.toolSteps,
    ...(result.trace ? { trace: result.trace } : {}),
    usage: result.usage,
    variant: variant.name,
    warnings: result.warnings,
  }
}

function completedScorer(): AgentScorer {
  return {
    name: "completed",
    score() {
      return {
        passed: true,
        reason: "Agent invocation completed.",
        score: 1,
      }
    },
  }
}

function normalizeTestSendInput<CALL_OPTIONS>(input: string | AgentRunInput<CALL_OPTIONS>): AgentRunInput<CALL_OPTIONS> {
  return typeof input === "string" ? { prompt: input } : input
}

function messagesFromTestInput<CALL_OPTIONS>(input: AgentRunInput<CALL_OPTIONS>): Message[] {
  const messages = [...(input.messages || [])]
  if (typeof input.message === "string") {
    messages.push(createMessage({ role: "user", text: input.message }))
  }
  else if (input.message) {
    messages.push(input.message)
  }
  if (typeof input.prompt === "string") {
    messages.push(createMessage({ role: "user", text: input.prompt }))
  }
  else if (Array.isArray(input.prompt)) {
    messages.push(...input.prompt)
  }
  return messages
}

function withTestHistory<CALL_OPTIONS>(
  input: AgentRunInput<CALL_OPTIONS>,
  history: Message[],
): AgentRunInput<CALL_OPTIONS> {
  if (!history.length) return input
  const messages = messagesFromTestInput(input)
  if (!messages.length) return input
  const rest = { ...input }
  delete rest.message
  delete rest.messages
  delete rest.prompt
  return {
    ...rest,
    messages: [...history, ...messages],
  }
}

function appendAssistantMessage(history: Message[], text: string): Message[] {
  if (!text) return history
  return [...history, createMessage({ role: "assistant", text })]
}

async function runEvalTest<CALL_OPTIONS>(
  runner: ReturnType<typeof createAgentTestRunner<AgentRuntimeConfig, CALL_OPTIONS>>,
  testCase: NormalizedEvalTest<CALL_OPTIONS>,
  variant: AgentEvalVariant,
): Promise<AgentObservationWithScores> {
  let observation: AgentObservation | undefined
  let history: Message[] = []
  const assertions: AgentScorer[] = []
  const context: AgentEvalTestContext<CALL_OPTIONS> = {
    get observation() {
      return observation
    },
    get reply() {
      return observation?.text || ""
    },
    calledTool(name) {
      assertions.push(callsTool(name))
    },
    capabilityExtension(capabilityId: string, key?: string) {
      return key === undefined
        ? observation?.extensions?.get(capabilityId)
        : observation?.extensions?.get(capabilityId, key)
    },
    completed() {
      assertions.push(completedScorer())
    },
    doesNotCallTool(name) {
      assertions.push(doesNotCallTool(name))
    },
    hasCapabilityExtension(capabilityId, key) {
      assertions.push(hasCapabilityExtension(capabilityId, key))
    },
    expect(scorer) {
      assertions.push(scorer)
    },
    async send(input) {
      const normalizedInput = normalizeTestSendInput(input)
      const runInput = withTestHistory(normalizedInput, history)
      const result = await runner.run(runInput)
      observation = toObservation(result, testCase, variant)
      history = appendAssistantMessage(messagesFromTestInput(runInput), result.text)
      return observation
    },
    textContains(expected) {
      assertions.push(textContains(expected))
    },
  }

  await testCase.test(context)
  if (!observation) {
    throw new Error("[vitehub] Agent Eval test() must call t.send(...).")
  }
  return {
    ...observation,
    scores: await scoreObservation(observation, [...testCase.scorers, ...assertions]),
  }
}

async function runScenario<
  TRuntimeConfig extends AgentRuntimeConfig,
  CALL_OPTIONS,
>(
  definition: AgentEvalDefinition<TRuntimeConfig, CALL_OPTIONS>,
  caller: string | undefined,
  input: AgentEvalInput<CALL_OPTIONS>,
): Promise<AgentObservationWithScores> {
  const agent = applyVariant(await resolveEvalAgent(definition.agent, caller), input.variant)
  const runner = createAgentTestRunner<TRuntimeConfig, CALL_OPTIONS>(agent, {
    name: input.variant.name,
    runtimeConfig: definition.runtimeConfig || ({} as TRuntimeConfig),
    workspace: definition.workspace,
  })
  if (input.scenario.kind === "test") {
    return await runEvalTest(runner, input.scenario, input.variant)
  }
  const result = await runner.run(input.scenario.input)
  const observation = toObservation(result, input.scenario, input.variant)
  return {
    ...observation,
    scores: await scoreObservation(observation, input.scenario.scorers),
  }
}

function aggregateScore(scores: AgentScore[]): AgentScore {
  if (!scores.length) {
    return {
      metadata: { scores: [] },
      reason: "No scorers configured.",
      score: 1,
    }
  }
  const score = scores.reduce((total, item) => total + item.score, 0) / scores.length
  return {
    metadata: { scores },
    passed: scores.every(item => item.passed !== false),
    score,
  }
}

export function defineEval<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
>(
  definition: AgentEvalDefinition<TRuntimeConfig, CALL_OPTIONS>,
): unknown {
  const caller = getCallerFile()
  const name = definition.name || (caller ? resolveEvalNameFromFile(caller) : "agent")
  const scenarios = normalizeEvalCases(definition, name)
  const variants = normalizeVariants(definition.variants)
  const data = scenarios.map(scenario => ({ input: { scenario } }))
  const opts = {
    data,
    async task(input: { scenario: NormalizedEvalCase<CALL_OPTIONS> }, variant: AgentEvalVariant = baselineVariant) {
      return await runScenario(definition, caller, { scenario: input.scenario, variant })
    },
    scorers: [{
      name: "agent-scorers",
      scorer({ output }: { output: AgentObservationWithScores }) {
        const score = aggregateScore(output.scores)
        return {
          description: score.reason,
          metadata: score.metadata,
          score: score.score,
        }
      },
    }],
  }
  return variants.length === 1 && variants[0]?.name === baselineVariant.name && definition.variants === undefined
    ? evalite(name, opts)
    : evalite.each(variants.map(variant => ({ input: variant, name: variant.name })))(name, opts)
}

export function textContains(expected: string | RegExp): AgentScorer {
  const pattern = typeof expected === "string" ? undefined : new RegExp(expected.source, expected.flags)
  return {
    name: "textContains",
    score(observation) {
      const matched = typeof expected === "string"
        ? observation.text.includes(expected)
        : pattern!.test(observation.text)
      if (pattern) pattern.lastIndex = 0
      return {
        passed: matched,
        reason: matched ? "Output contained the expected text." : "Output did not contain the expected text.",
        score: matched ? 1 : 0,
      }
    },
  }
}

export function doesNotLeakSource(): AgentScorer {
  const sourceLeakPattern = /(?:^|\n)\s*(?:import|export|function|class|const|let|var|interface|type)\s+[\w{*]/m
  return {
    name: "doesNotLeakSource",
    score(observation) {
      const leaked = sourceLeakPattern.test(observation.text)
      return {
        passed: !leaked,
        reason: leaked ? "Output appears to contain source code." : "Output did not appear to contain source code.",
        score: leaked ? 0 : 1,
      }
    },
  }
}

function stepIncludesTool(step: AgentToolStep, name: string): boolean {
  const expected = normalizeObservedToolName(name)
  return Boolean(step.toolCalls?.some(call => normalizeObservedToolName(call.toolName) === expected)
    || step.toolErrors?.some(error => normalizeObservedToolName(error.toolName) === expected)
    || step.toolResults?.some(result => normalizeObservedToolName(result.toolName) === expected))
}

function normalizeObservedToolName(name: unknown): string | undefined {
  if (typeof name !== "string") return
  return name === "bash" ? "shell" : name
}

export function callsTool(name: string): AgentScorer {
  return {
    name: `callsTool:${name}`,
    score(observation) {
      const called = observation.toolSteps.some(step => stepIncludesTool(step, name))
      return {
        passed: called,
        reason: called ? `Tool "${name}" was called.` : `Tool "${name}" was not called.`,
        score: called ? 1 : 0,
      }
    },
  }
}

export function doesNotCallTool(name: string): AgentScorer {
  return {
    name: `doesNotCallTool:${name}`,
    score(observation) {
      const called = observation.toolSteps.some(step => stepIncludesTool(step, name))
      return {
        passed: !called,
        reason: called ? `Tool "${name}" was called.` : `Tool "${name}" was not called.`,
        score: called ? 0 : 1,
      }
    },
  }
}

export function hasCapabilityExtension(capabilityId: string, key?: string): AgentScorer {
  return {
    name: key === undefined ? `hasCapabilityExtension:${capabilityId}` : `hasCapabilityExtension:${capabilityId}.${key}`,
    score(observation) {
      const value = key === undefined
        ? observation.extensions?.get(capabilityId)
        : observation.extensions?.get(capabilityId, key)
      const found = value !== undefined
      return {
        metadata: {
          capabilityId,
          ...(key === undefined ? {} : { key }),
        },
        passed: found,
        reason: found
          ? `Capability "${capabilityId}" reported an extension.`
          : `Capability "${capabilityId}" did not report an extension.`,
        score: found ? 1 : 0,
      }
    },
  }
}

function readTotalTokens(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return
  const totalTokens = (usage as { totalTokens?: unknown }).totalTokens
  if (typeof totalTokens === "number") return totalTokens
  const inputTokens = (usage as { inputTokens?: unknown }).inputTokens
  const outputTokens = (usage as { outputTokens?: unknown }).outputTokens
  if (typeof inputTokens === "number" && typeof outputTokens === "number") {
    return inputTokens + outputTokens
  }
}

export function staysUnderTokenBudget(limit: number): AgentScorer {
  return {
    name: `staysUnderTokenBudget:${limit}`,
    score(observation) {
      const totalTokens = readTotalTokens(observation.usage)
      if (totalTokens === undefined) {
        return {
          passed: false,
          reason: "Usage did not include token counts.",
          score: 0,
        }
      }
      const passed = totalTokens <= limit
      return {
        metadata: { limit, totalTokens },
        passed,
        reason: passed ? "Token usage stayed within budget." : "Token usage exceeded budget.",
        score: passed ? 1 : Math.max(0, limit / totalTokens),
      }
    },
  }
}
