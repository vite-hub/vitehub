import { agentDiagnostics } from "../agent-diagnostics.ts"
import { getMessageText } from "../messages.ts"
import { hasRuntimeType, isRuntimeRecord } from "./runtime-type.ts"
import { importServerEnvModule } from "./server-env.ts"

import type { AskAnswers, AskEntry, AskQuestion, AskQuestions } from "../ask.ts"
import type { Message } from "../messages.ts"
import type { AgentRunInput } from "../types.ts"

type Advocaat = typeof import("advocaat")
type AdvocaatQuestion = Parameters<Advocaat["ask"]>[1][string]
type AdvocaatEntry = Parameters<Advocaat["ask"]>[0]

/** The Server Env group that `typesafeEnv()` declares. */
export const typesafeEnvGroup = "typesafe"

const typesafeEnvHint = "Declare it in the Vite config with `env: { server: { typesafe: typesafeEnv() } }` from `vite-hub/env`."

export interface AskRequestContext {
  abortSignal?: AbortSignal
  /** Passed to `useServerEnv()` so Cloudflare bindings resolve for this request. */
  event?: unknown
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
  for (const batch of batches) {
    context.abortSignal?.throwIfAborted()
    const answers = await advocaat.ask(entry, batch, { ...options, signal: context.abortSignal })
    context.abortSignal?.throwIfAborted()
    for (const name of Object.keys(batch)) {
      if (!Object.hasOwn(answers, name)) throw new Error(`[vitehub] Jev response is missing answer "${name}".`)
      const answer = answers[name]
      const question = questions[name]
      if (question.type === "choice" && !hasValidChoiceAnswer(question, answer)) {
        throw new Error(`[vitehub] Jev choice answer "${name}" is missing a valid probability distribution.`)
      }
      const scoreAnswer: Record<string, unknown> | undefined = isRuntimeRecord(answer) && answer.type === "score" ? answer : undefined
      output[name] = question?.type === "score" && scoreAnswer
        ? { ...scoreAnswer, legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])) }
        : answer
    }
  }
  // SAFETY: Each requested key has an SDK answer; choice distributions are validated and score legends restore public criteria.
  return Object.fromEntries(Object.entries(output)) as AskAnswers<Q>
}
