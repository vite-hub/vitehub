import { basename, dirname, extname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { evalite } from "evalite"

import {
  defineAgent,
  type AgentInput,
  type AgentModelInput,
  type AgentRunInput,
  type AgentRuntimeContext,
  type AgentRuntimeConfig,
  type AgentToolStep,
  type MaybePromise,
  type WorkspaceAgentDefinition,
  type WorkspaceAgentOptions,
} from "./index.ts"
import {
  createAgentTestRunner,
  type AgentTestRunResult,
} from "./test.ts"
import type { WorkspaceName } from "@vitehub/workspace"

export interface AgentScore {
  metadata?: unknown
  passed?: boolean
  reason?: string
  score: number
}

export interface AgentObservation {
  finishReason?: unknown
  metadata?: unknown
  raw: unknown
  scenario: string
  text: string
  toolSteps: AgentToolStep[]
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

export interface AgentEvalDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = never,
> {
  agent?: AgentEvalAgent<TRuntimeConfig> | (() => MaybePromise<AgentEvalAgent<TRuntimeConfig>>)
  name?: string
  runtimeConfig?: TRuntimeConfig | (() => MaybePromise<TRuntimeConfig>)
  scenarios: Array<AgentEvalScenario<CALL_OPTIONS>>
  scorers?: AgentScorer[]
  variants?: AgentEvalVariant[]
  workspace?: WorkspaceName
}

type AgentEvalAgent<TRuntimeConfig extends AgentRuntimeConfig> = AgentInput<AgentRuntimeContext<TRuntimeConfig>>

interface NormalizedEvalScenario<CALL_OPTIONS> extends AgentEvalScenario<CALL_OPTIONS> {
  scorers: AgentScorer[]
}

interface AgentEvalInput<CALL_OPTIONS> {
  scenario: NormalizedEvalScenario<CALL_OPTIONS>
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
  const match = line.match(/\(((?:file:\/\/)?[^()]+?\.(?:c|m)?[jt]s)(?::\d+:\d+)?\)$/)
    || line.match(/^\s*at\s+((?:file:\/\/)?.+?\.(?:c|m)?[jt]s)(?::\d+:\d+)?$/)
  return match?.[1]
}

export function sourceMappedEvalFile(current: string): string {
  return current.replace(/([/\\])dist[/\\]eval\.js$/, "$1src$1eval.ts")
}

async function resolveSiblingAgent<TRuntimeConfig extends AgentRuntimeConfig>(
  caller: string | undefined,
): Promise<AgentEvalAgent<TRuntimeConfig>> {
  if (!caller) {
    throw new Error("[vitehub] defineEval() could not infer the sibling Agent Definition. Pass agent explicitly.")
  }

  const extension = extname(caller)
  const base = basename(caller, extension)
  const sibling = base === "eval"
    ? join(dirname(caller), `config${extension}`)
    : caller.slice(0, -extension.length).replace(/\.eval$/, "") + extension
  const module = await import(pathToFileURL(sibling).href) as { default?: AgentEvalAgent<TRuntimeConfig> }
  if (!module.default) {
    throw new Error(`[vitehub] defineEval() expected ${sibling} to default export an Agent Definition.`)
  }
  return module.default
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
  if (!isWorkspaceAgentDefinition(agent)) {
    throw new Error("[vitehub] Agent Evaluation variants with model or instructions require an inspectable defineAgent({ workspace }) Agent Definition.")
  }

  const options = agent.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<TRuntimeConfig>
  return defineAgent({
    ...options,
    ...(variant.instructions !== undefined ? { instructions: variant.instructions } : {}),
    ...(variant.model !== undefined ? { model: variant.model as never } : {}),
  })
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
    scorers: [...globalScorers, ...(scenario.scorers || [])],
  }))
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

function toObservation<CALL_OPTIONS>(result: AgentTestRunResult, scenario: AgentEvalScenario<CALL_OPTIONS>, variant: AgentEvalVariant): AgentObservation {
  return {
    finishReason: result.finishReason,
    metadata: scenario.metadata,
    raw: result.raw,
    scenario: scenario.name,
    text: result.text,
    toolSteps: result.toolSteps,
    usage: result.usage,
    variant: variant.name,
    warnings: result.warnings,
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
  const scenarios = normalizeScenarios(definition.scenarios, definition.scorers)
  const variants = normalizeVariants(definition.variants)
  const name = definition.name || (caller ? resolveEvalNameFromFile(caller) : "agent")
  const data = scenarios.map(scenario => ({ input: { scenario } }))
  const opts = {
    data,
    async task(input: { scenario: NormalizedEvalScenario<CALL_OPTIONS> }, variant: AgentEvalVariant = baselineVariant) {
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
  return Boolean(step.toolCalls?.some(call => call.toolName === name)
    || step.toolErrors?.some(error => error.toolName === name)
    || step.toolResults?.some(result => result.toolName === name))
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
