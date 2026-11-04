import type { AiGatewayAsk } from "@vite-hub/gateways"
import type { Diagnostic } from "nostics"

/** The value that you map back to your data. It must be unique within its group. */
export type ChoiceValue = string | number

/** One option of a group. `value` is yours, `label` and `aliases` are what the model reads. */
export interface ChoiceOption<TValue extends ChoiceValue = ChoiceValue> {
  /** Other names for the option, such as codes, abbreviations, or translations. */
  aliases?: readonly string[]
  /** What people call the option. */
  label: string
  /** Your id for the option. It comes back in the selection. */
  value: TValue
}

type MaybePromise<T> = T | Promise<T>

/** A set of options that belong to one decision, such as one filter. */
export interface ChoiceGroup<TValue extends ChoiceValue = ChoiceValue> {
  /** Tells the model how to read this group. Keep it short and specific to your data. */
  hints?: string
  /** What people call the group, such as "Supplier". */
  label: string
  /** `true` (default): any number of options, each included or excluded. `false`: at most one option. */
  multiple?: boolean
  /** A list, or a function that loads the list for one request. Annotate the parameter of the function: its type is the `context` of `resolve()`. */
  options: readonly ChoiceOption<TValue>[] | ((context: never) => MaybePromise<readonly ChoiceOption<TValue>[]>)
}

export type ChoiceGroups = Record<string, ChoiceGroup>

export interface ChoicesLimits {
  /** Most options in one group. Default 100. */
  options: number
  /** Most groups. Default 40. */
  groups: number
  /** Longest text in characters. Default 300. */
  text: number
  /** Most options in all groups together. Default 100. */
  totalOptions: number
}

export interface ChoicesThresholds {
  /** The lowest probability that decides one option. Default 0.5. */
  option?: number
  /** The lowest probability that the options can express the text. Default 0.6. */
  supported?: number
}

export interface ChoicesDefinition<TGroups extends ChoiceGroups> {
  /** Where the questions go. Use a gateway that has `ask()`, such as `typesafe()` or `vercel()` from `vite-hub/gateways`. */
  gateway: { ask: AiGatewayAsk }
  groups: TGroups
  /** Tells the model what the options are about. It is added to every question. */
  hints?: string
  limits?: Partial<ChoicesLimits>
  /** A label for logs and the CLI. It never connects anything. */
  name?: string
  thresholds?: ChoicesThresholds
}

type OptionValue<TOptions> = TOptions extends readonly ChoiceOption<infer TValue>[]
  ? TValue
  : TOptions extends (context: never) => infer TResult
    ? Awaited<TResult> extends readonly ChoiceOption<infer TValue> [] ? TValue : never
    : never

export type GroupValue<TGroup> = TGroup extends { options: infer TOptions } ? OptionValue<TOptions> : never

/** A group with `multiple` left as `true`: the options the text includes and excludes. */
export interface MultipleSelection<TValue extends ChoiceValue = ChoiceValue> {
  exclude: TValue[]
  include: TValue[]
}

/** A group with `multiple: false`: the best option, or `null`, and every option by probability. */
export interface SingleSelection<TValue extends ChoiceValue = ChoiceValue> {
  /** How much the best option stands out, from 0 to 1. */
  confidence: number
  /** Every option, from the most to the least likely. */
  ranked: { probability: number, value: TValue }[]
  /** The best option when it is above `thresholds.option`, else `null`. */
  value: TValue | null
}

/** The result for each group, typed from the options that you declared. */
export type ChoicesSelection<TGroups> = {
  [K in keyof TGroups]: TGroups[K] extends { multiple: false }
    ? SingleSelection<Extract<GroupValue<TGroups[K]>, ChoiceValue>>
    : MultipleSelection<Extract<GroupValue<TGroups[K]>, ChoiceValue>>
}

/** A nostics error. Its `code` is one of `DECISIONS_R0001` to `DECISIONS_R0006`. */
export type ChoicesError = Diagnostic

export type ChoicesResult<TData> = readonly [error: ChoicesError, data?: undefined] | readonly [error: undefined, data: TData]

export interface ChoicesRequest<TContext> {
  /** Passed to `options` functions. Put what they need here, such as the tenant. */
  context: TContext
  /** Cancels the request to the gateway. */
  signal?: AbortSignal
}

/** What `resolve()` would send, without sending it. */
export interface ChoicesPlan {
  /** The questions for `gateway.ask()`. One per option of a multiple group, one per single group, and `supported`. */
  questions: Record<string, unknown>
  /** The state for `gateway.ask()`. */
  state: { groups: { hints?: string, label: string, multiple: boolean, options: { aliases?: readonly string[], label: string, value: ChoiceValue }[] }[], query: string }
}

type UnionToIntersection<TUnion> = (TUnion extends unknown ? (value: TUnion) => void : never) extends (value: infer TIntersection) => void ? TIntersection : never

type OptionsContext<TGroup> = TGroup extends { options: (context: infer TContext) => unknown } ? TContext : never

/** The `context` that `resolve()` needs: the parameter types of the `options` functions of the groups. `unknown` when no group needs one. */
export type GroupsContext<TGroups> = UnionToIntersection<{ [K in keyof TGroups]: OptionsContext<TGroups[K]> }[keyof TGroups]>

export type ChoicesArgs<TContext> = unknown extends TContext
  ? [request?: { signal?: AbortSignal }]
  : [request: ChoicesRequest<TContext> & { context: TContext }]

export interface Choices<TGroups extends ChoiceGroups> {
  /** Shows the questions and the state that `resolve()` would send. Nothing leaves your server. */
  inspect: (text: string, ...args: ChoicesArgs<GroupsContext<TGroups>>) => Promise<ChoicesResult<ChoicesPlan>>
  readonly name: string | undefined
  /** Asks the gateway which options the text names. It returns `[error, selection]` and never throws. */
  resolve: (text: string, ...args: ChoicesArgs<GroupsContext<TGroups>>) => Promise<ChoicesResult<ChoicesSelection<TGroups>>>
}
