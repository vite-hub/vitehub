import { gatewayDiagnostics } from "./diagnostics.ts"
import { hasValidChoiceAnswer } from "./jev.ts"

import type { AskAnswer, AskAnswers, AskChanceAnswer, AskChoiceAnswer, AskChoiceCriteria, AskChoiceQuestion, AskQuestion, AskQuestions, AskScoreAnswer, AskScoreCriteria, AskScoreQuestion } from "./ask.ts"
import type { AiGatewayAsk, AiGatewayAskError, AiGatewayUsage } from "./types.ts"

/** One `gateway.ask()` call that `scriptedAsk()` received. */
export interface ScriptedAskCall {
  questions: AskQuestions
  signal?: AbortSignal
  state: unknown
}

export interface ScriptedAskOptions {
  /** Returns this error from every `ask()`, as a provider would: `GATEWAYS_R0008` for a rejected key, `GATEWAYS_R0009` for a provider that keeps failing. */
  error?: "GATEWAYS_R0008" | "GATEWAYS_R0009"
  /** The token counts that `onUsage` receives after each `ask()`. Default: zero. */
  usage?: AiGatewayUsage["usage"]
}

/** Returns the answer to one question. Build it with `answers`. */
export type AskScript = (key: string, question: AskQuestion, state: unknown) => AskAnswer<AskQuestion>

function invalid(problem: string): Error {
  return gatewayDiagnostics.GATEWAYS_TESTING_ANSWER_INVALID({ problem })
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

function checkProbability(helper: string, probability: number): void {
  if (!isProbability(probability)) throw invalid(`${helper} got the probability ${probability}. It must be from 0 to 1.`)
}

function choice<const T extends AskChoiceCriteria>(question: AskChoiceQuestion<T>, label: keyof T & string, probability?: number): AskChoiceAnswer<T>
function choice(question: AskQuestion, label: string, probability?: number): AskChoiceAnswer
function choice(question: AskQuestion, label: string, probability = 1): AskChoiceAnswer {
  if (question.type !== "choice") throw invalid(`answers.choice() needs a choice question. It got a ${question.type} question.`)
  if (!Object.hasOwn(question.criteria, label)) throw invalid(`answers.choice() got the label ${JSON.stringify(label)}. The question has ${Object.keys(question.criteria).map(item => JSON.stringify(item)).join(", ")}.`)
  checkProbability("answers.choice()", probability)
  const labels = Object.keys(question.criteria)
  const minimum = 1 / labels.length
  if (probability < minimum) throw invalid(`answers.choice() needs a probability of at least ${minimum} so the chosen label has a highest probability. It got ${probability}.`)
  const rest = labels.length === 1 ? 0 : probability === minimum ? probability : (1 - probability) / (labels.length - 1)
  return { choice: label, confidence: probability - rest, probabilities: Object.fromEntries(labels.map(item => [item, item === label ? probability : rest])), type: "choice" }
}

function score<const T extends AskScoreCriteria>(question: AskScoreQuestion<T>, level: number, probability?: number): AskScoreAnswer<T>
function score(question: AskQuestion, level: number, probability?: number): AskScoreAnswer
function score(question: AskQuestion, level: number, probability = 1): AskScoreAnswer {
  if (question.type !== "score") throw invalid(`answers.score() needs a score question. It got a ${question.type} question.`)
  const levels = question.criteria.length
  if (!Number.isInteger(level) || level < 0 || level >= levels) throw invalid(`answers.score() got the level ${level}. The question has levels 0 to ${levels - 1}.`)
  checkProbability("answers.score()", probability)
  const rest = (1 - probability) / (levels - 1)
  const probabilities = question.criteria.map((_, index) => index === level ? probability : rest)
  const value = probabilities.reduce((sum, item, index) => sum + item * index, 0)
  return {
    confidence: probability,
    legend: Object.fromEntries(question.criteria.map((entry, index) => [String(index), entry])),
    probabilities: Object.fromEntries(probabilities.map((item, index) => [String(index), item])),
    ratio: value / (levels - 1),
    score: value,
    type: "score",
  }
}

function chance(probability: number): AskChanceAnswer {
  checkProbability("answers.chance()", probability)
  return { chance: probability, type: "chance" }
}

function first<const Q extends AskQuestion>(question: Q): AskAnswer<Q>
function first(question: AskQuestion): AskAnswer<AskQuestion> {
  switch (question.type) {
    case "choice": return choice(question, Object.keys(question.criteria)[0]!)
    case "switch": return Object.keys(question.criteria)[0]!
    case "score": return score(question, 0)
    case "chance": return chance(1)
    case "if": return true
  }
}

/** Build answers that pass the same checks as a real Jev answer. */
export const answers: {
  /** `{ chance }`, the probability of yes. */
  chance: typeof chance
  /** `label` gets `probability` (default 1), and the other labels share the rest. The chosen label must tie for or have the highest probability. */
  choice: typeof choice
  /** The first label of a choice or switch question, level 0 of a score question, and yes for chance and if questions. */
  first: typeof first
  /** `level` gets `probability` (default 1), and the other levels share the rest. */
  score: typeof score
} = { chance, choice, first, score }

function scriptedError(code: NonNullable<ScriptedAskOptions["error"]>): AiGatewayAskError {
  if (code === "GATEWAYS_R0008") return Object.assign(gatewayDiagnostics.GATEWAYS_R0008({ provider: "scripted", status: 401 }), { providerStatus: 401, status: 503 } as const)
  return Object.assign(gatewayDiagnostics.GATEWAYS_R0009({ attempts: 3, provider: "scripted", status: 503 }), { providerStatus: 503, status: 502 } as const)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validAnswer(question: AskQuestion, answer: unknown): boolean {
  switch (question.type) {
    case "if": return typeof answer === "boolean"
    case "switch": return typeof answer === "string" && Object.hasOwn(question.criteria, answer)
    case "chance": return isRecord(answer) && answer.type === "chance" && isProbability(answer.chance)
    case "score": {
      if (!isRecord(answer) || answer.type !== "score" || !isProbability(answer.confidence) || !isProbability(answer.ratio)
        || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1
        || !isRecord(answer.legend) || !isRecord(answer.probabilities)) return false
      const { legend, probabilities } = answer
      return question.criteria.every((_, level) => Object.hasOwn(legend, level) && legend[level] !== undefined && isProbability(probabilities[level]))
    }
    case "choice": {
      if (!hasValidChoiceAnswer(question, answer)) return false
      // SAFETY: The Jev check validates that `choice` and every probability have the expected types.
      const { choice, probabilities } = answer as unknown as AskChoiceAnswer
      return Object.values(probabilities).every(item => item <= probabilities[choice]!)
    }
  }
}

/**
 * A gateway with `ask()` that answers each question with `script(key, question, state)`, so tests need no model or key.
 * It checks answers against their questions, records each call in `calls`, and calls `onUsage` after each successful `ask()`.
 *
 * @example
 * const { gateway, calls } = scriptedAsk((key, question) => answers.first(question))
 */
export function scriptedAsk(script: AskScript, options: ScriptedAskOptions = {}): { calls: ScriptedAskCall[], gateway: { ask: AiGatewayAsk } } {
  const calls: ScriptedAskCall[] = []
  const ask: AiGatewayAsk = async (state, questions, askOptions) => {
    calls.push({ questions, signal: askOptions?.signal, state })
    askOptions?.signal?.throwIfAborted()
    if (options.error) return [scriptedError(options.error), undefined]
    const entries = Object.entries(questions).map(([name, question]) => {
      const answer = script(name, question, state)
      if (answer === undefined) throw gatewayDiagnostics.GATEWAYS_JEV_RESPONSE_INVALID({ name, problem: "missing" })
      if (!validAnswer(question, answer)) {
        if (question.type === "choice") throw gatewayDiagnostics.GATEWAYS_JEV_RESPONSE_INVALID({ name, problem: "choice" })
        throw invalid(`scriptedAsk() got an invalid answer for the ${question.type} question ${JSON.stringify(name)}.`)
      }
      return [name, answer] as const
    })
    askOptions?.onUsage?.({ provider: "scripted", usage: options.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
    // SAFETY: Each answer passes the check for its question type and criteria.
    return [undefined, Object.fromEntries(entries) as AskAnswers<typeof questions>]
  }
  return { calls, gateway: { ask } }
}
