import { agentDiagnostics } from "../agent-diagnostics.ts"
import { getMessageText } from "../messages.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"
import { importServerEnvModule } from "./server-env.ts"

import type { AskAnswers, AskEntry, AskQuestion, AskQuestions } from "../ask.ts"
import type { Message } from "../messages.ts"
import type { AgentRunInput, AgentUsageRecord } from "../types.ts"
import type { IfQuestion, Question as JevQuestion, Questions as JevQuestions, SwitchQuestion } from "advocaat"
import type { TraceEvent } from "@vite-hub/runtime"

type Advocaat = typeof import("advocaat")
type AdvocaatQuestion = JevQuestion | IfQuestion | SwitchQuestion
type AdvocaatEntry = Parameters<Advocaat["ask"]>[0]

/** The Server Env group that `typesafeEnv()` declares. */
export const typesafeEnvGroup = "typesafe"

const typesafeEnvHint = "Declare it in the Vite config with `env: { server: { typesafe: typesafeEnv() } }` from `vite-hub/env`."

export interface AskRequestContext {
  abortSignal?: AbortSignal
  /** Passed to `useServerEnv()` so Cloudflare bindings resolve for this request. */
  event?: unknown
  /** Receives one `agent.tool.*` event per question and one `agent.usage.recorded` event per Jev request. */
  observe?: (event: TraceEvent) => Promise<void>
  /** Receives the usage of each Jev request: its model, provider, and token counts. */
  recordUsage?: (usage: AgentUsageRecord) => void
}

type AskStateInput = Pick<AgentRunInput, "data" | "prompt">

async function loadAdvocaat(): Promise<Advocaat> {
  try {
    return await import("advocaat")
  }
  catch (error) {
    throw agentDiagnostics.AGENT_R0934({
      message: "[vitehub] TypeSafe Jev requests require the advocaat package. Install it with: pnpm add advocaat",
      cause: error,
    })
  }
}

function unseal(value: unknown): unknown {
  return isRuntimeRecord(value) && hasRuntimeType(value.unseal, "function") ? value.unseal() : value
}

function optionalString(value: unknown): string | undefined {
  const resolved = unseal(value)
  return hasRuntimeType(resolved, "string") && resolved.trim() ? resolved.trim() : undefined
}

/** Reads `env.server.typesafe` through the generated Server Env module. */
async function typesafeOptions(context: AskRequestContext) {
  let module: Awaited<ReturnType<typeof importServerEnvModule>>
  try {
    module = await importServerEnvModule()
  }
  catch (error) {
    throw agentDiagnostics.AGENT_R0935({ message: `[vitehub] TypeSafe Jev requests read the Server Env group "${typesafeEnvGroup}", but Server Env is not available. ${typesafeEnvHint}`, cause: error })
  }
  const env = module.useServerEnv?.(context.event)
  const group = isRuntimeRecord(env) ? env[typesafeEnvGroup] : undefined
  if (!isRuntimeRecord(group)) {
    throw agentDiagnostics.AGENT_R0935({ message: `[vitehub] TypeSafe Jev requests read the Server Env group "${typesafeEnvGroup}", but it is not declared. ${typesafeEnvHint}` })
  }
  const provider = group.provider === "vercel" ? "vercel" : "typesafe"
  const apiKey = optionalString(group.apiKey)
  // Without a key, the Vercel provider lets advocaat use VERCEL_OIDC_TOKEN on Vercel.
  if (!apiKey && provider === "typesafe") {
    throw agentDiagnostics.AGENT_R0936({ message: `[vitehub] TypeSafe Jev requests require env.server.${typesafeEnvGroup}.apiKey. Set TYPESAFE_API_KEY, or use typesafeEnv({ provider: "vercel" }) with AI_GATEWAY_API_KEY.` })
  }
  const model = optionalString(group.model)
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    provider,
  } as const
}

function toEntry(value: unknown): AdvocaatEntry {
  // Normalize each entry root to the SDK contract, preserving scalars inside JSON structures.
  const serialized = JSON.stringify(value)
  const parsed: AskEntry = serialized === undefined ? null : JSON.parse(serialized)
  return hasRuntimeType(parsed, "number") || hasRuntimeType(parsed, "boolean") ? String(parsed) : parsed
}

function invalidQuestion(name: string) {
  return agentDiagnostics.AGENT_R0937({ message: `[vitehub] Jev question "${name}" must be built with ask.choice(), ask.score(), ask.chance(), ask.if(), or ask.switch().` })
}

function validateQuestionCriteria(name: string, question: AskQuestion): void {
  if (question.type === "if" && (!Number.isFinite(question.threshold) || question.threshold < 0 || question.threshold > 1)) {
    throw agentDiagnostics.AGENT_R0937({ message: `[vitehub] Jev question "${name}" threshold must be a finite number between 0 and 1.` })
  }
  if (question.type === "choice" || question.type === "switch") {
    const count = isRuntimeRecord(question.criteria) && !Array.isArray(question.criteria)
      ? Object.keys(question.criteria).length
      : 0
    if (count < 2 || count > 255) {
      throw agentDiagnostics.AGENT_R0937({ message: `[vitehub] Jev question "${name}" ${question.type} criteria must have between 2 and 255 choices.` })
    }
  }
  else if (question.type === "score") {
    const count = Array.isArray(question.criteria) ? question.criteria.length : 0
    if (count < 2 || count > 10) {
      throw agentDiagnostics.AGENT_R0937({ message: `[vitehub] Jev question "${name}" score criteria must have between 2 and 10 levels.` })
    }
  }
}

function hasValidChoiceAnswer(question: Extract<AskQuestion, { type: "choice" }>, answer: unknown): answer is Record<string, unknown> {
  if (!isRuntimeRecord(answer) || answer.type !== "choice" || !hasRuntimeType(answer.choice, "string") || !isRuntimeRecord(answer.probabilities)) return false
  if (!hasRuntimeType(answer.confidence, "number") || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return false
  if (!isRuntimeRecord(question.criteria) || !Object.hasOwn(question.criteria, answer.choice)) return false
  const probabilities = answer.probabilities
  const labels = Object.keys(question.criteria)
  const probabilityLabels = Object.keys(probabilities)
  if (labels.length !== probabilityLabels.length || probabilityLabels.some(label => !Object.hasOwn(question.criteria, label))) return false
  const total = labels.reduce((sum, label) => {
    const probability = probabilities[label]
    return sum + (hasRuntimeType(probability, "number") && Number.isFinite(probability) && probability >= 0 && probability <= 1 ? probability : Number.NaN)
  }, 0)
  return Number.isFinite(total) && Math.abs(total - 1) <= 1e-6
}

interface JevResponse {
  answers: Record<string, unknown>
  model?: string
  usage?: { inputTokens?: number, outputTokens?: number }
}

function finiteNumber(value: unknown): number | undefined {
  return hasRuntimeType(value, "number") && Number.isFinite(value) ? value : undefined
}

/** The SDK question for one Jev request: `if` asks a yes/no question and `switch` asks a choice. */
function toJevQuestion(question: AdvocaatQuestion): JevQuestion {
  if (question.type === "if") return { instructions: question.instructions, type: "noul" }
  if (question.type === "switch") return { criteria: question.criteria, instructions: question.instructions, type: "choice" }
  return question
}

/**
 * Sends one batch through the SDK client, which also returns the model and the token usage,
 * and maps the answers as `advocaat.ask()` does.
 */
async function requestJev(
  advocaat: Advocaat,
  state: AdvocaatEntry,
  batch: Record<string, AdvocaatQuestion>,
  options: Awaited<ReturnType<typeof typesafeOptions>> & { signal?: AbortSignal },
): Promise<JevResponse> {
  const { signal, ...client } = options
  const wire: JevQuestions = Object.fromEntries(Object.entries(batch).map(([name, question]) => [name, toJevQuestion(question)]))
  const result = await advocaat.typesafe(client).systemOne({ questions: wire, state }, { signal })
  const answers: Record<string, unknown> = Object.create(null)
  for (const [name, answer] of Object.entries(result.answers)) {
    const question = batch[name]
    if (answer.type === "noul") answers[name] = question?.type === "if" ? answer.noul > question.threshold : { chance: answer.noul, type: "chance" }
    else if (answer.type === "score") answers[name] = question?.type === "score" ? { ...answer, ratio: answer.score / (question.criteria.length - 1) } : answer
    else answers[name] = question?.type === "switch" ? answer.choice : answer
  }
  // The TypeSafe API returns its response body as is, so read model and usage defensively.
  const model: unknown = result.model
  const usage: unknown = result.usage
  return {
    answers,
    ...(hasRuntimeType(model, "string") && model ? { model } : {}),
    ...(isRuntimeRecord(usage)
      ? { usage: { inputTokens: finiteNumber(usage.input_tokens), outputTokens: finiteNumber(usage.output_tokens) } }
      : {}),
  }
}

/** The usage record of one Jev request, or undefined when the response has no token counts. */
function jevUsageRecord(provider: string, response: JevResponse): AgentUsageRecord | undefined {
  const inputTokens = response.usage?.inputTokens
  const outputTokens = response.usage?.outputTokens
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  return {
    ...(response.model ? { model: response.model } : {}),
    provider,
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(inputTokens !== undefined && outputTokens !== undefined ? { totalTokens: inputTokens + outputTokens } : {}),
    },
  }
}

/** The value a person reads first: the selected label, the score, the chance, or the boolean. */
function jevAnswerValue(answer: unknown): unknown {
  if (!isRuntimeRecord(answer)) return answer
  if (answer.type === "choice") return answer.choice
  if (answer.type === "score") return answer.score
  if (answer.type === "chance") return answer.chance
  return undefined
}

/**
 * Records each question of one Jev request as `agent.tool.start`, then `agent.tool.finish` or `agent.tool.error`,
 * and the token usage of the request as `agent.usage.recorded`. Without an observer, nothing is recorded.
 */
async function observeJevBatch(
  observe: AskRequestContext["observe"],
  options: { model?: string, provider: string },
  questions: AskQuestions,
  batch: Record<string, AdvocaatQuestion>,
  position: { count: number, index: number },
) {
  const names = Object.keys(batch)
  const startedAt = Date.now()
  const settled = new Set<string>()
  const emit = async (event: TraceEvent) => {
    try {
      await observe?.(event)
    }
    catch {
      // An observer must not change the answers.
    }
  }
  const batchAttributes = {
    "ask.batch.count": position.count,
    "ask.batch.index": position.index,
    "ask.batch.size": names.length,
    "gen_ai.operation.name": "ask",
    "gen_ai.provider.name": options.provider,
  }
  const questionAttributes = (name: string) => ({
    ...batchAttributes,
    ...(options.model ? { "ask.model": options.model } : {}),
    "ask.key": name,
    "ask.type": questions[name]?.type,
    "step.id": `ask:${name}`,
    "tool.id": `ask:${name}`,
    "tool.name": "ask",
    "vitehub.activity.kind": "tool",
  })
  if (observe) {
    for (const name of names) {
      await emit({
        attributes: { ...questionAttributes(name), "tool.hasInput": true, "tool.input": batch[name] },
        name: "agent.tool.start",
        type: "run",
      })
    }
  }
  return {
    async answered(name: string, answer: unknown, model: string | undefined) {
      settled.add(name)
      if (!observe) return
      const value = jevAnswerValue(answer)
      const confidence = isRuntimeRecord(answer) ? finiteNumber(answer.confidence) : undefined
      const probabilities = isRuntimeRecord(answer) && isRuntimeRecord(answer.probabilities) ? { ...answer.probabilities } : undefined
      await emit({
        attributes: {
          ...questionAttributes(name),
          ...(model ? { "ask.model": model } : {}),
          ...(value !== undefined ? { "ask.answer": value } : {}),
          ...(confidence !== undefined ? { "ask.confidence": confidence } : {}),
          ...(probabilities ? { "ask.probabilities": probabilities } : {}),
          "tool.durationMs": Date.now() - startedAt,
          "tool.hasOutput": true,
          "tool.output": answer,
        },
        name: "agent.tool.finish",
        type: "run",
      })
    },
    async failed(error: unknown) {
      if (!observe) return
      const message = error instanceof Error ? error.message : String(error)
      const status = isRuntimeRecord(error) && Number.isInteger(error.status) ? error.status : undefined
      const requestId = isRuntimeRecord(error) && hasRuntimeType(error.requestId, "string") && error.requestId ? error.requestId : undefined
      for (const name of names) {
        if (settled.has(name)) continue
        settled.add(name)
        await emit({
          attributes: {
            ...questionAttributes(name),
            "error.message": message,
            ...(error instanceof Error ? { "error.name": error.name } : {}),
            ...(status !== undefined ? { "error.status": status } : {}),
            ...(requestId ? { "error.requestId": requestId } : {}),
            "tool.durationMs": Date.now() - startedAt,
            "tool.error": message,
          },
          name: "agent.tool.error",
          type: "error",
        })
      }
    },
    async usage(response: JevResponse) {
      if (!observe || !response.usage) return
      const { inputTokens, outputTokens } = response.usage
      await emit({
        attributes: {
          ...batchAttributes,
          "ask.durationMs": Date.now() - startedAt,
          "usage.hasCost": false,
          "usage.hasRaw": false,
          ...(inputTokens !== undefined ? { "usage.inputTokens": inputTokens } : {}),
          ...(response.model ? { "usage.model": response.model } : {}),
          ...(outputTokens !== undefined ? { "usage.outputTokens": outputTokens } : {}),
          "usage.provider": options.provider,
          ...(inputTokens !== undefined && outputTokens !== undefined ? { "usage.totalTokens": inputTokens + outputTokens } : {}),
        },
        name: "agent.usage.recorded",
        type: "run",
      })
    },
  }
}

function toAdvocaatQuestion(name: string, question: AskQuestion): AdvocaatQuestion {
  validateQuestionCriteria(name, question)
  const instructions = toEntry(question.instructions)
  switch (question.type) {
    case "chance":
      return { criteria: question.criteria ? Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, toEntry(value)])) : undefined, instructions, type: "noul" }
    case "choice":
    case "switch":
      return { ...question, instructions, criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, toEntry(value)])) }
    case "score": {
      const [first, second, ...rest] = question.criteria
      return { ...question, instructions, criteria: [toEntry(first), toEntry(second), ...rest.map(toEntry)] }
    }
    case "if":
      return question
  }
  throw invalidQuestion(name)
}

/** Jev state for a run: Invocation `data` when present, else the prompt text, else the latest user message. */
export function askState(input: AskStateInput, prompt: unknown, messages: readonly Message[]): unknown {
  // `data` is part of the Agent Run Input once `defineAgent({ data })` is available. Read it when a caller sets it.
  if ("data" in input && input.data !== undefined) return input.data
  if (hasRuntimeType(prompt, "string") && prompt.trim()) return prompt.trim()
  const latest = [...messages].reverse().find(message => message.role === "user")
  return latest ? getMessageText(latest).trim() : null
}

/** UTF-8 serialized bytes provide a conservative token bound, with room for request framing. */
function jevInputSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function jevQuestionBatches(state: AdvocaatEntry, wire: Record<string, AdvocaatQuestion>): Record<string, AdvocaatQuestion>[] {
  const sharedSize = jevInputSize(state) + 2048
  const maxRequestSize = 60_000
  const maxQuestionSize = 30_000
  if (sharedSize >= maxQuestionSize) throw new RangeError("[vitehub] Jev shared state exceeds the safe per-question input budget.")
  const batches: Record<string, AdvocaatQuestion>[] = []
  let batch: Record<string, AdvocaatQuestion> = Object.create(null)
  let size = sharedSize
  for (const [name, question] of Object.entries(wire)) {
    const questionSize = jevInputSize({ [name]: question }) + 128
    if (sharedSize + questionSize > maxQuestionSize) throw new RangeError(`[vitehub] Jev question "${name}" exceeds the safe per-question input budget.`)
    if (size + questionSize > maxRequestSize && Object.keys(batch).length) {
      batches.push(batch)
      batch = Object.create(null)
      size = sharedSize
    }
    batch[name] = question
    size += questionSize
  }
  if (Object.keys(batch).length) batches.push(batch)
  return batches
}

/** Runs independent keyed questions in bounded Jev requests; empty questions require no credentials or API call. */
export async function askJev<const Q extends AskQuestions>(context: AskRequestContext, state: unknown, questions: Q): Promise<AskAnswers<Q>> {
  if (!isRuntimeRecord(questions) || Array.isArray(questions)) {
    throw agentDiagnostics.AGENT_R0937({ message: "[vitehub] defineAgent({ driver.ask }) must resolve to an object of Jev questions." })
  }
  const wire = Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    if (!isRuntimeRecord(question)) throw invalidQuestion(name)
    return [name, toAdvocaatQuestion(name, question)]
  }))
  if (!Object.keys(wire).length) {
    // SAFETY: An empty validated question map has no answers and matches AskAnswers<Q>.
    return {} as AskAnswers<Q>
  }
  const entry = toEntry(state)
  const batches = jevQuestionBatches(entry, wire)
  const advocaat = await loadAdvocaat()
  const options = await typesafeOptions(context)
  const output: Record<string, unknown> = Object.create(null)
  for (const [batchIndex, batch] of batches.entries()) {
    context.abortSignal?.throwIfAborted()
    const observed = await observeJevBatch(context.observe, options, questions, batch, { count: batches.length, index: batchIndex })
    try {
      const response = await requestJev(advocaat, entry, batch, { ...options, signal: context.abortSignal })
      await observed.usage(response)
      const usage = jevUsageRecord(options.provider, response)
      if (usage) context.recordUsage?.(usage)
      context.abortSignal?.throwIfAborted()
      for (const name of Object.keys(batch)) {
        if (!Object.hasOwn(response.answers, name)) throw new Error(`[vitehub] Jev response is missing answer "${name}".`)
        const answer = response.answers[name]
        const question = questions[name]
        if (question.type === "choice" && !hasValidChoiceAnswer(question, answer)) {
          throw new Error(`[vitehub] Jev choice answer "${name}" is missing a valid probability distribution.`)
        }
        const scoreAnswer: Record<string, unknown> | undefined = isRuntimeRecord(answer) && answer.type === "score" ? answer : undefined
        output[name] = question?.type === "score" && scoreAnswer
          ? { ...scoreAnswer, legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])) }
          : answer
        await observed.answered(name, output[name], response.model)
      }
    }
    catch (error) {
      await observed.failed(error)
      throw error
    }
  }
  // SAFETY: Each requested key has an SDK answer; choice distributions are validated and score legends restore public criteria.
  return Object.fromEntries(Object.entries(output)) as AskAnswers<Q>
}
