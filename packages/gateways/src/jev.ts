import { gatewayDiagnostics } from "./diagnostics.ts"

import type { AskAnswers, AskEntry, AskQuestion, AskQuestions } from "./ask.ts"
import type { AiGatewayUsage } from "./types.ts"
import type { IfQuestion, Question as JevQuestion, Questions as JevQuestions, SwitchQuestion } from "advocaat"

type Advocaat = typeof import("advocaat")
type AdvocaatQuestion = JevQuestion | IfQuestion | SwitchQuestion
type AdvocaatEntry = Parameters<Advocaat["ask"]>[0]

/** One trace event of a Jev request. ViteHub Agents record these in the Invocation trace. */
export interface AiGatewayTraceEvent {
  attributes: Record<string, unknown>
  name: string
  type: "error" | "run"
}

export interface JevRequestContext {
  abortSignal?: AbortSignal
  /** Receives one `agent.tool.*` event per question and one `agent.usage.recorded` event per Jev request. */
  observe?: (event: AiGatewayTraceEvent) => Promise<void>
  /** Receives the usage of each Jev request: its model, provider, and token counts. */
  recordUsage?: (usage: AiGatewayUsage) => void
  /** Resolves the route of the gateway for this request. */
  route: () => Promise<JevRoute>
}

async function loadAdvocaat(): Promise<Advocaat> {
  try {
    return await import("advocaat")
  }
  catch (error) {
    throw gatewayDiagnostics.GATEWAYS_R0006({
      message: "[vitehub] TypeSafe Jev requests require the advocaat package. Install it with: pnpm add advocaat",
      cause: error,
    })
  }
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * One resolved Jev route. `protocol` selects the advocaat client: the TypeSafe API (also behind a Cloudflare AI Gateway
 * custom provider) or Vercel AI Gateway.
 */
export interface JevRoute {
  apiKey?: string
  baseURL?: string
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string>
  /** The variables that hold the credentials, for the fix of a rejected key. Undefined when the caller passed them. */
  keyEnv?: string
  /** Shown in diagnostics, such as "Cloudflare AI Gateway". */
  label: string
  model?: string
  /** The gateway name in usage records and traces, such as `cloudflareTypesafe`. */
  name: string
  protocol: "typesafe" | "vercel"
}

/** The custom provider URL of a Cloudflare AI Gateway. The TypeSafe client appends `/v1/systemone`. */
export function cloudflareJevBaseURL(gateway: { accountId: string, gatewayId: string, slug?: string }): string {
  const segment = (value: string) => encodeURIComponent(value.trim())
  return `https://gateway.ai.cloudflare.com/v1/${segment(gateway.accountId)}/${segment(gateway.gatewayId)}/custom-${segment(gateway.slug?.trim() || "typesafe")}`
}

function toEntry(value: unknown): AdvocaatEntry {
  // Normalize each entry root to the SDK contract, preserving scalars inside JSON structures.
  const serialized = JSON.stringify(value)
  const parsed: AskEntry = serialized === undefined ? null : JSON.parse(serialized)
  return typeof parsed === "number" || typeof parsed === "boolean" ? String(parsed) : parsed
}

function invalidQuestion(name: string) {
  return gatewayDiagnostics.GATEWAYS_R0007({ message: `[vitehub] Jev question "${name}" must be built with ask.choice(), ask.score(), ask.chance(), ask.if(), or ask.switch().` })
}

function validateQuestionCriteria(name: string, question: AskQuestion): void {
  if (question.type === "if" && (!Number.isFinite(question.threshold) || question.threshold < 0 || question.threshold > 1)) {
    throw gatewayDiagnostics.GATEWAYS_R0007({ message: `[vitehub] Jev question "${name}" threshold must be a finite number between 0 and 1.` })
  }
  if (question.type === "choice" || question.type === "switch") {
    const count = isObject(question.criteria) && !Array.isArray(question.criteria)
      ? Object.keys(question.criteria).length
      : 0
    if (count < 2 || count > 255) {
      throw gatewayDiagnostics.GATEWAYS_R0007({ message: `[vitehub] Jev question "${name}" ${question.type} criteria must have between 2 and 255 choices.` })
    }
  }
  else if (question.type === "score") {
    const count = Array.isArray(question.criteria) ? question.criteria.length : 0
    if (count < 2 || count > 10) {
      throw gatewayDiagnostics.GATEWAYS_R0007({ message: `[vitehub] Jev question "${name}" score criteria must have between 2 and 10 levels.` })
    }
  }
}

function hasValidChoiceAnswer(question: Extract<AskQuestion, { type: "choice" }>, answer: unknown): answer is Record<string, unknown> {
  if (!isObject(answer) || answer.type !== "choice" || typeof answer.choice !== "string" || !isObject(answer.probabilities)) return false
  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return false
  if (!isObject(question.criteria) || !Object.hasOwn(question.criteria, answer.choice)) return false
  const probabilities = answer.probabilities
  const labels = Object.keys(question.criteria)
  const probabilityLabels = Object.keys(probabilities)
  if (labels.length !== probabilityLabels.length || probabilityLabels.some(label => !Object.hasOwn(question.criteria, label))) return false
  const total = labels.reduce((sum, label) => {
    const probability = probabilities[label]
    return sum + (typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1 ? probability : Number.NaN)
  }, 0)
  return Number.isFinite(total) && Math.abs(total - 1) <= 1e-6
}

interface JevResponse {
  answers: Record<string, unknown>
  model?: string
  usage?: { inputTokens?: number, outputTokens?: number }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
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
  options: JevRoute & { signal?: AbortSignal },
): Promise<JevResponse> {
  const { apiKey, baseURL, fetch, headers, protocol, signal } = options
  const wire: JevQuestions = Object.fromEntries(Object.entries(batch).map(([name, question]) => [name, toJevQuestion(question)]))
  // A Cloudflare AI Gateway custom provider forwards the TypeSafe protocol, so it uses the TypeSafe client at its URL.
  const client = { ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}), ...(fetch ? { fetch } : {}), ...(options.model ? { model: options.model } : {}), provider: protocol }
  const result = await advocaat.typesafe(client).systemOne({ questions: wire, state }, { ...(headers ? { headers } : {}), signal })
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
    ...(typeof model === "string" && model ? { model } : {}),
    ...(isObject(usage)
      ? { usage: { inputTokens: finiteNumber(usage.input_tokens), outputTokens: finiteNumber(usage.output_tokens) } }
      : {}),
  }
}

const retryableJevStatuses = new Set([408, 429, 500, 502, 503, 504])
const jevAttempts = 3

function errorStatus(error: unknown): number | undefined {
  if (!isObject(error)) return undefined
  // Advocaat exposes provider HTTP failures as `statusCode`; older adapters use `status`.
  const status = Number.isInteger(error.statusCode) ? Number(error.statusCode) : error.status
  return Number.isInteger(status) ? Number(status) : undefined
}

function errorRequestId(error: unknown): string | undefined {
  return isObject(error) && typeof error.requestId === "string" && error.requestId ? error.requestId : undefined
}

function waitForRetry(attempt: number, signal?: AbortSignal): Promise<void> {
  const delay = 250 * 2 ** attempt * (0.75 + Math.random() / 2)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, delay)
    function abort() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", abort, { once: true })
  })
}

/**
 * Sends one batch and retries transient provider failures. Jev questions do not change state, so a retry is safe.
 * A rejected key fails at once with GATEWAYS_R0008. A provider that keeps failing ends with GATEWAYS_R0009.
 * Both keep the provider error as `cause` and expose `status`, `providerStatus`, and `requestId`.
 */
async function requestJevWithRetry(
  advocaat: Advocaat,
  state: AdvocaatEntry,
  batch: Record<string, AdvocaatQuestion>,
  options: JevRoute & { signal?: AbortSignal },
): Promise<JevResponse> {
  const provider = options.label
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestJev(advocaat, state, batch, options)
    }
    catch (error) {
      if (options.signal?.aborted) throw error
      const status = errorStatus(error)
      const details = { cause: error, providerStatus: status, requestId: errorRequestId(error) }
      if (status === 401 || status === 403) {
        throw Object.assign(gatewayDiagnostics.GATEWAYS_R0008({ provider, status, env: options.keyEnv, cause: error }), { ...details, status: 503 })
      }
      // A failed fetch is surfaced as a TypeError without a status. Response
      // decoding and validation can also throw TypeError, but those are
      // deterministic failures and must not be retried. Fetch implementations
      // attach the underlying transport error as `cause`.
      const transient = status === undefined
        ? error instanceof TypeError && isObject(error) && "cause" in error
        : retryableJevStatuses.has(status)
      if (!transient) throw error
      if (attempt + 1 >= jevAttempts) {
        throw Object.assign(gatewayDiagnostics.GATEWAYS_R0009({ provider, status, attempts: jevAttempts, cause: error }), { ...details, status: 502 })
      }
      await waitForRetry(attempt, options.signal)
    }
  }
}

/** The usage record of one Jev request, or undefined when the response has no token counts. */
function jevUsageRecord(provider: string, response: JevResponse): AiGatewayUsage | undefined {
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
  if (!isObject(answer)) return answer
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
  observe: JevRequestContext["observe"],
  options: { model?: string, provider: string },
  questions: AskQuestions,
  batch: Record<string, AdvocaatQuestion>,
  position: { count: number, index: number },
) {
  const names = Object.keys(batch)
  const startedAt = Date.now()
  const settled = new Set<string>()
  const emit = async (event: AiGatewayTraceEvent) => {
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
      const confidence = isObject(answer) ? finiteNumber(answer.confidence) : undefined
      const probabilities = isObject(answer) && isObject(answer.probabilities) ? { ...answer.probabilities } : undefined
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
      const status = isObject(error) && Number.isInteger(error.providerStatus) ? error.providerStatus : errorStatus(error)
      const requestId = errorRequestId(error)
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
export async function askJev<const Q extends AskQuestions>(context: JevRequestContext, state: unknown, questions: Q): Promise<AskAnswers<Q>> {
  if (!isObject(questions) || Array.isArray(questions)) {
    throw gatewayDiagnostics.GATEWAYS_R0007({ message: "[vitehub] Jev questions must be an object of questions built with ask." })
  }
  const wire = Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    if (!isObject(question)) throw invalidQuestion(name)
    return [name, toAdvocaatQuestion(name, question)]
  }))
  if (!Object.keys(wire).length) {
    // SAFETY: An empty validated question map has no answers and matches AskAnswers<Q>.
    return {} as AskAnswers<Q>
  }
  const entry = toEntry(state)
  const batches = jevQuestionBatches(entry, wire)
  const advocaat = await loadAdvocaat()
  const options = await context.route()
  const output: Record<string, unknown> = Object.create(null)
  for (const [batchIndex, batch] of batches.entries()) {
    context.abortSignal?.throwIfAborted()
    const observed = await observeJevBatch(context.observe, { ...(options.model ? { model: options.model } : {}), provider: options.name }, questions, batch, { count: batches.length, index: batchIndex })
    try {
      const response = await requestJevWithRetry(advocaat, entry, batch, { ...options, signal: context.abortSignal })
      await observed.usage(response)
      const usage = jevUsageRecord(options.name, response)
      if (usage) context.recordUsage?.(usage)
      context.abortSignal?.throwIfAborted()
      for (const name of Object.keys(batch)) {
        if (!Object.hasOwn(response.answers, name)) throw new Error(`[vitehub] Jev response is missing answer "${name}".`)
        const answer = response.answers[name]
        const question = questions[name]
        if (question.type === "choice" && !hasValidChoiceAnswer(question, answer)) {
          throw new Error(`[vitehub] Jev choice answer "${name}" is missing a valid probability distribution.`)
        }
        const scoreAnswer: Record<string, unknown> | undefined = isObject(answer) && answer.type === "score" ? answer : undefined
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
