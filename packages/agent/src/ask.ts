import { hasRuntimeType } from "./internal/runtime-type.ts"

/** A JSON value that TypeSafe Jev can read. */
export type AskJson = string | number | boolean | null | AskJson[] | { [key: string]: AskJson }
/** A JSON scalar, object, array, or `null`. Root numbers and booleans become text in SDK requests; nested values stay native. */
export type AskEntry = AskJson

/** Option labels mapped to their descriptions. Jev accepts 2 to 255 options. */
export type AskChoiceCriteria = { [label: string]: AskEntry }
/** Two or more option labels without descriptions. */
export type AskChoiceLabels = readonly [string, string, ...string[]]
/** Descriptions of each score level, indexed from zero. Jev accepts 2 to 10 levels. */
export type AskScoreCriteria = readonly [AskEntry, AskEntry, ...AskEntry[]]
/** Optional descriptions of what counts as true or false. */
export type AskChanceCriteria = { false?: AskEntry, true?: AskEntry } | null

/** Labels become criteria with `null` descriptions. An object stays as it is. */
export type AskNamedCriteria<T> = T extends AskChoiceLabels ? { [K in T[number]]: null } : T
/** Score level keys: the tuple indices for a fixed rubric, otherwise any numeric string. */
export type AskScoreLevel<T extends AskScoreCriteria> = number extends T["length"] ? `${number}` : Extract<keyof T, `${number}`>

export interface AskChoiceAnswer<T extends AskChoiceCriteria = AskChoiceCriteria> {
  readonly type: "choice"
  /** The label with the highest probability. */
  readonly choice: keyof T & string
  /** How much the top option stands out, from zero to one. */
  readonly confidence: number
  /** Probability of each option, keyed by its label. */
  readonly probabilities: { readonly [K in keyof T]: number }
}

export interface AskScoreAnswer<T extends AskScoreCriteria = AskScoreCriteria> {
  readonly type: "score"
  /** How much the top level stands out, from zero to one. */
  readonly confidence: number
  /** Level descriptions keyed by level number. */
  readonly legend: { readonly [K in AskScoreLevel<T>]: T[number] }
  /** Probability of each level, keyed by level number. */
  readonly probabilities: { readonly [K in AskScoreLevel<T>]: number }
  /** `score` divided by the highest level, from zero to one. */
  readonly ratio: number
  /** Sum of each level number times its probability. It can fall between levels. */
  readonly score: number
}

export interface AskChanceAnswer {
  readonly type: "chance"
  /** Probability of a yes answer, from zero to one. */
  readonly chance: number
}

declare const askAnswerType: unique symbol

/** Carries the answer type of a question so `driver.ask` can infer the Invocation output. */
export interface AskAnswerType<TAnswer> {
  readonly [askAnswerType]?: TAnswer
}

/** Selects one labeled option. Answers with the label, confidence, and probabilities. */
export interface AskChoiceQuestion<T extends AskChoiceCriteria = AskChoiceCriteria> extends AskAnswerType<AskChoiceAnswer<T>> {
  readonly criteria: T
  readonly instructions: AskEntry
  readonly type: "choice"
}

/** Selects one labeled option. Answers with the label only. */
export interface AskSwitchQuestion<T extends AskChoiceCriteria = AskChoiceCriteria> extends AskAnswerType<keyof T & string> {
  readonly criteria: T
  readonly instructions: AskEntry
  readonly type: "switch"
}

/** Rates the state against ordered levels. */
export interface AskScoreQuestion<T extends AskScoreCriteria = AskScoreCriteria> extends AskAnswerType<AskScoreAnswer<T>> {
  readonly criteria: T
  readonly instructions: AskEntry
  readonly type: "score"
}

/** A yes or no question. Answers with the probability of yes. */
export interface AskChanceQuestion extends AskAnswerType<AskChanceAnswer> {
  readonly criteria?: AskChanceCriteria
  readonly instructions: AskEntry
  readonly type: "chance"
}

/** A yes or no question. Answers `true` when the probability of yes is above `threshold`. */
export interface AskIfQuestion extends AskAnswerType<boolean> {
  readonly instructions: string
  readonly threshold: number
  readonly type: "if"
}

export type AskQuestion = AskChanceQuestion | AskChoiceQuestion | AskIfQuestion | AskScoreQuestion | AskSwitchQuestion
/** Named questions that Jev answers together against the same state. */
export type AskQuestions = { readonly [name: string]: AskQuestion }

/** The answer type of one question. */
export type AskAnswer<Q extends AskQuestion> = Q extends AskAnswerType<infer TAnswer> ? Exclude<TAnswer, undefined> : never
/** Answers keyed by question name. This is the output of an Agent with `driver.ask`. */
export type AskAnswers<Q extends AskQuestions> = { readonly [K in keyof Q]: AskAnswer<Q[K]> }

function isLabels(criteria: AskChoiceCriteria | AskChoiceLabels): criteria is AskChoiceLabels {
  return Array.isArray(criteria)
}

function named(criteria: AskChoiceCriteria | AskChoiceLabels): AskChoiceCriteria {
  return isLabels(criteria) ? Object.fromEntries(criteria.map(label => [label, null])) : criteria
}

function choice<const T extends AskChoiceCriteria | AskChoiceLabels>(instructions: AskEntry, criteria: T): AskChoiceQuestion<AskNamedCriteria<T>>
function choice(instructions: AskEntry, criteria: AskChoiceCriteria | AskChoiceLabels): AskChoiceQuestion {
  return { criteria: named(criteria), instructions, type: "choice" }
}

function askSwitch<const T extends AskChoiceCriteria | AskChoiceLabels>(instructions: AskEntry, criteria: T): AskSwitchQuestion<AskNamedCriteria<T>>
function askSwitch(instructions: AskEntry, criteria: AskChoiceCriteria | AskChoiceLabels): AskSwitchQuestion {
  return { criteria: named(criteria), instructions, type: "switch" }
}

function score<const T extends AskScoreCriteria>(instructions: AskEntry, criteria: T): AskScoreQuestion<T> {
  return { criteria, instructions, type: "score" }
}

function chance(instructions: AskEntry, criteria?: AskChanceCriteria): AskChanceQuestion {
  return criteria === undefined ? { instructions, type: "chance" } : { criteria, instructions, type: "chance" }
}

function askIf(instructions: string, options: { threshold?: number } = {}): AskIfQuestion {
  const threshold = options.threshold ?? 0.5
  if (!Number.isFinite(threshold)) throw new TypeError("ask.if threshold must be a finite number")
  if (threshold < 0 || threshold > 1) throw new TypeError("ask.if threshold must be between 0 and 1")
  return { instructions, threshold, type: "if" }
}

function each<T, Q extends AskQuestion>(
  items: readonly T[],
  options: { key: (item: T) => string, question: (item: T) => Q },
): Record<string, Q> {
  const questions: Record<string, Q> = Object.create(null)
  for (const item of items) {
    const key = options.key(item)
    if (!hasRuntimeType(key, "string") || !key.trim()) {
      throw new TypeError("ask.each keys must be non-empty strings")
    }
    if (Object.hasOwn(questions, key)) {
      throw new TypeError(`ask.each produced duplicate key ${JSON.stringify(key)}`)
    }
    questions[key] = options.question(item)
  }
  return questions
}

/**
 * Builds TypeSafe Jev questions for `defineAgent({ driver: { ask } })`.
 * Each builder returns a plain question object. The Driver sends questions in deterministic sequential batches when needed; the combined serialized shared state and each question must fit below 30,000 bytes, including request overhead.
 */
export const ask: {
  chance: typeof chance
  choice: typeof choice
  each: typeof each
  if: typeof askIf
  score: typeof score
  switch: typeof askSwitch
} = {
  /** A yes or no question. Answers `{ chance }`, the probability of yes. */
  chance,
  /** Selects one option. Answers `{ choice, confidence, probabilities }`. */
  choice,
  /** Builds a keyed question map from a list. */
  each,
  /** A yes or no question. Answers `true` when the probability of yes is above `threshold` (0 to 1, default `0.5`). */
  if: askIf,
  /** Rates the state against 2 to 10 ordered levels. Answers `{ score, ratio, confidence, legend, probabilities }`. */
  score,
  /** Selects one option. Answers with the selected label only. */
  switch: askSwitch,
}
