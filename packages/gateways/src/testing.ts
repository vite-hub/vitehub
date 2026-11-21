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

function checkProbability(helper: string, probability: number): void {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw invalid(`${helper} got the probability ${probability}. It must be from 0 to 1.`)
}

function choice<const T extends AskChoiceCriteria>(question: AskChoiceQuestion<T>, label: keyof T & string, probability?: number): AskChoiceAnswer<T>
function choice(question: AskQuestion, label: string, probability?: number): AskChoiceAnswer
function choice(question: AskQuestion, label: string, probability = 1): AskChoiceAnswer {
  if (question.type !== "choice") throw invalid(`answers.choice() needs a choice question. It got a ${question.type} question.`)
  if (!Object.hasOwn(question.criteria, label)) throw invalid(`answers.choice() got the label ${JSON.stringify(label)}. The question has ${Object.keys(question.criteria).map(item => JSON.stringify(item)).join(", ")}.`)
  checkProbability("answers.choice()", probability)
  const labels = Object.keys(question.criteria)
  const rest = (1 - probability) / (labels.length - 1)
  return { choice: label, confidence: probability, probabilities: Object.fromEntries(labels.map(item => [item, item === label ? probability : rest])), type: "choice" }
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
  /** `label` gets `probability` (default 1), and the other labels share the rest. */
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

/**
 * A gateway with `ask()` that answers each question with `script(key, question, state)`, so tests need no model or key.
 * It checks the answers as a real gateway does, records each call in `calls`, and calls `onUsage` after each `ask()`.
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
      if (question.type === "choice" && !hasValidChoiceAnswer(question, answer)) throw gatewayDiagnostics.GATEWAYS_JEV_RESPONSE_INVALID({ name, problem: "choice" })
      return [name, answer] as const
    })
    askOptions?.onUsage?.({ provider: "scripted", usage: options.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
    // SAFETY: Each question key has the script's answer, and choice answers pass the Jev distribution check.
    return [undefined, Object.fromEntries(entries) as AskAnswers<typeof questions>]
  }
  return { calls, gateway: { ask } }
}
