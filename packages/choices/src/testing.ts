import { answers } from "@vite-hub/gateways/testing"

import { choicesDiagnostics } from "./diagnostics.ts"
import { resolveSelection } from "./selection-gateway.ts"

import type { AiGatewayAsk, AskAnswers, AskQuestion } from "@vite-hub/gateways"
import type { SelectionGateway } from "./selection-gateway.ts"
import type { ChoiceGroups, ChoicesPlan, ChoiceValue, GroupsContext, GroupValue, MultipleSelection, SingleSelection } from "./types.ts"

type MaybePromise<T> = T | Promise<T>

/** Return it from `selectionGateway()` to say that the options cannot express the text. `resolve()` returns `DECISIONS_R0004`. */
export const unsupported: unique symbol = Symbol("unsupported")

type GroupSelection<TValue> = TValue | null | undefined | { exclude?: readonly TValue[], include?: readonly TValue[] }

/**
 * The selection that `selectionGateway()` answers, keyed by group: an option value or `null` for a group with `multiple: false`,
 * and `{ include, exclude }` for the other groups. A group that you leave out selects nothing.
 * Pass `typeof groups` as the type argument of `selectionGateway()` to check the keys and values.
 */
export type TestSelection<TGroups extends ChoiceGroups = ChoiceGroups> = string extends keyof TGroups
  ? { readonly [group: string]: GroupSelection<ChoiceValue> }
  : { readonly [K in keyof TGroups]?: TGroups[K] extends { multiple: false }
      ? GroupValue<TGroups[K]> | null
      : { exclude?: readonly GroupValue<TGroups[K]>[], include?: readonly GroupValue<TGroups[K]>[] } }

type TestContext<TGroups extends ChoiceGroups> = string extends keyof TGroups ? unknown : GroupsContext<TGroups>

type TestAnswer<TGroups extends ChoiceGroups> = TestSelection<TGroups> | typeof unsupported

function invalid(problem: string): Error {
  return choicesDiagnostics.DECISIONS_TESTING_SELECTION_INVALID({ problem })
}

/**
 * A gateway for unit tests: `resolve()` returns the selection that you give, keyed by your own groups and option values.
 * Pass a function to answer from the text and the `context` of the request. Return `unsupported` for `DECISIONS_R0004`,
 * and throw for `DECISIONS_R0005`. The values are checked against the loaded options without applying model thresholds.
 *
 * @example
 * defineChoices({ gateway: selectionGateway({ supplier: { include: ['nord'] }, chart: 'line' }), groups })
 */
export function selectionGateway<TGroups extends ChoiceGroups = ChoiceGroups>(
  selection: TestAnswer<TGroups> | ((text: string, context: TestContext<TGroups>) => MaybePromise<TestAnswer<TGroups>>),
): { ask: AiGatewayAsk } {
  const gateway: SelectionGateway = {
    async ask() {
      throw invalid("selectionGateway() only works as the gateway of defineChoices().")
    },
    async [resolveSelection](plan, keys, context) {
      const selected = typeof selection === "function" ? await selection(plan.query, context as TestContext<TGroups>) : selection
      if (selected === unsupported) return undefined
      const values: Readonly<Record<string, GroupSelection<ChoiceValue>>> = selected
      const unknown = Object.keys(values).filter(key => !keys.includes(key))
      if (unknown.length) throw invalid(`The selection names ${unknown.map(key => JSON.stringify(key)).join(", ")}, but the groups are ${keys.map(key => JSON.stringify(key)).join(", ")}.`)

      return Object.fromEntries(plan.groups.map((group, index): [string, MultipleSelection | SingleSelection] => {
        const key = keys[index]!
        const value = Object.hasOwn(values, key) ? values[key] : undefined
        const optionValues = group.options.map(option => option.value)
        const checkValue = (item: ChoiceValue) => {
          if (!optionValues.includes(item)) throw invalid(`Group "${key}" has no option with the value ${JSON.stringify(item)}.`)
        }
        if (!group.multiple) {
          if (typeof value === "object" && value !== null) throw invalid(`Group "${key}" has multiple: false. Select one option value or null, not { include, exclude }.`)
          const chosen = value ?? null
          if (chosen !== null) checkValue(chosen)
          const ranked = optionValues.map(item => ({ probability: item === chosen ? 1 : 0, value: item })).sort((left, right) => right.probability - left.probability)
          return [key, { confidence: chosen === null ? 0 : 1, ranked, value: chosen }]
        }
        if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value))) throw invalid(`Group "${key}" takes any number of options. Select { include, exclude }, not one value.`)
        const include = value?.include ?? []
        const exclude = value?.exclude ?? []
        if (!Array.isArray(include) || !Array.isArray(exclude)) throw invalid(`Group "${key}" needs arrays of option values for include and exclude.`)
        for (const item of [...include, ...exclude]) checkValue(item)
        return [key, { exclude: optionValues.filter(item => !include.includes(item) && exclude.includes(item)), include: optionValues.filter(item => include.includes(item)) }]
      }))
    },
  }
  return gateway
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * An offline gateway that answers by word match, for get-started and local dev without an API key. It is not a model:
 * an option is included when the text names its label, and excluded when "except", "not", or "without" comes before it.
 * A single group chooses the first option that the text names. An infer group also matches words of five letters or more
 * from the option descriptions. Text with the word "unsupported" fails the supported check, so you can see `DECISIONS_R0004`.
 */
export function wordGateway(): { ask: AiGatewayAsk } {
  const ask: AiGatewayAsk = async (state, questions, options) => {
    options?.signal?.throwIfAborted()
    // SAFETY: defineChoices() sends the state that buildPlan() makes.
    const { groups, query } = state as ChoicesPlan["state"]
    const text = query.toLowerCase()
    const answer = (key: string, question: AskQuestion) => {
      if (key === "supported") return answers.chance(text.includes("unsupported") ? 0.1 : 0.95)
      const [, groupIndex, optionIndex] = /^g(\d+)(?:_o(\d+))?$/.exec(key) ?? []
      const group = groups[Number(groupIndex)]
      if (!group || question.type !== "choice") return answers.first(question)
      const labels = group.options.map(option => option.label)
      const named = labels.filter(label => text.includes(label.toLowerCase()))
      if (optionIndex === undefined && group.infer) {
        // Descriptions are in the question criteria, not in the state.
        const words = (label: string) => {
          const criteria = question.criteria[label]
          return typeof criteria === "string" ? criteria.toLowerCase().match(/\w{5,}/g) ?? [] : []
        }
        const fit = labels.find(label => named.includes(label) || words(label).some(word => text.includes(word)))
        return answers.choice(question, fit ?? labels[0]!, fit ? 0.8 : Math.max(0.4, 1 / labels.length))
      }
      if (optionIndex === undefined) {
        const best = named[0] ?? "(none)"
        return answers.choice(question, best, best === "(none)" ? 0.9 : 0.8)
      }
      const label = labels[Number(optionIndex)]!.toLowerCase()
      const excluded = new RegExp(`(except|not|without)\\s+(\\w+\\s+)?${escapeRegExp(label)}`).test(text)
      return answers.choice(question, !text.includes(label) ? "none" : excluded ? "exclude" : "include", 0.9)
    }
    const entries = Object.entries(questions).map(([key, question]) => [key, answer(key, question)] as const)
    options?.onUsage?.({ provider: "scripted", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
    return [undefined, Object.fromEntries(entries) as AskAnswers<typeof questions>]
  }
  return { ask }
}
