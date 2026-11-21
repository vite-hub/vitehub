import { answers, scriptedAsk } from "@vite-hub/gateways/testing"

import { choicesDiagnostics } from "./diagnostics.ts"
import { readPlanRequest } from "./plan-request.ts"

import type { AiGatewayAsk, AskAnswer, AskQuestion } from "@vite-hub/gateways"
import type { ChoiceGroups, ChoicesPlan, ChoiceValue, GroupsContext, GroupValue } from "./types.ts"

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
 * and throw for `DECISIONS_R0005`. The answers go through the same checks as a model answer.
 *
 * @example
 * defineChoices({ gateway: selectionGateway({ supplier: { include: ['nord'] }, chart: 'line' }), groups })
 */
export function selectionGateway<TGroups extends ChoiceGroups = ChoiceGroups>(
  selection: TestAnswer<TGroups> | ((text: string, context: TestContext<TGroups>) => MaybePromise<TestAnswer<TGroups>>),
): { ask: AiGatewayAsk } {
  const ask: AiGatewayAsk = async (state, questions) => {
    const request = readPlanRequest(state)
    if (!request) throw invalid("selectionGateway() answers only the questions of defineChoices(). Pass it as the `gateway` of defineChoices().")
    // SAFETY: A state with a plan request comes from buildPlan().
    const plan = state as ChoicesPlan["state"]
    // SAFETY: `resolve()` types `context` from the `options` functions of the same groups.
    const answer = typeof selection === "function" ? await selection(plan.query, request.context as TestContext<TGroups>) : selection
    const selected: Readonly<Record<string, GroupSelection<ChoiceValue>>> = answer === unsupported ? {} : answer
    const unknown = Object.keys(selected).filter(key => !request.keys.includes(key))
    if (unknown.length) throw invalid(`The selection names ${unknown.map(key => JSON.stringify(key)).join(", ")}, but the groups are ${request.keys.map(key => JSON.stringify(key)).join(", ")}.`)

    const output: Record<string, AskAnswer<AskQuestion>> = {}
    if (questions.supported) output.supported = answers.chance(answer === unsupported ? 0 : 1)
    plan.groups.forEach((group, groupIndex) => {
      const key = request.keys[groupIndex]!
      const value = selected[key]
      const labelOf = (item: ChoiceValue) => {
        const option = group.options.find(candidate => candidate.value === item)
        if (!option) throw invalid(`Group "${key}" has no option with the value ${JSON.stringify(item)}.`)
        return option.label
      }
      const single = questions[`g${groupIndex}`]
      if (single) {
        if (typeof value === "object" && value !== null) throw invalid(`Group "${key}" has multiple: false. Select one option value or null, not { include, exclude }.`)
        if (value !== undefined && value !== null) output[`g${groupIndex}`] = answers.choice(single, labelOf(value))
        else if (!group.infer) output[`g${groupIndex}`] = answers.choice(single, "(none)")
        // An infer group has no "none" answer. Equal probabilities are below the default threshold for three or more options.
        else output[`g${groupIndex}`] = answers.choice(single, group.options[0]!.label, 1 / group.options.length)
        return
      }
      if (value !== undefined && (typeof value !== "object" || value === null)) throw invalid(`Group "${key}" takes any number of options. Select { include, exclude }, not one value.`)
      const include = new Set(value?.include?.map(labelOf))
      const exclude = new Set(value?.exclude?.map(labelOf))
      group.options.forEach((option, optionIndex) => {
        const question = questions[`g${groupIndex}_o${optionIndex}`]
        if (question) output[`g${groupIndex}_o${optionIndex}`] = answers.choice(question, include.has(option.label) ? "include" : exclude.has(option.label) ? "exclude" : "none")
      })
    })
    // SAFETY: The answers follow the question keys that buildPlan() makes, and the `answers` helpers build valid Jev answers.
    return [undefined, output as never]
  }
  return { ask }
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
  return scriptedAsk((key, question, state) => {
    // SAFETY: defineChoices() sends the state that buildPlan() makes.
    const { groups, query } = state as ChoicesPlan["state"]
    const text = query.toLowerCase()
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
      return answers.choice(question, fit ?? labels[0]!, fit ? 0.8 : 0.4)
    }
    if (optionIndex === undefined) {
      const best = named[0] ?? "(none)"
      return answers.choice(question, best, best === "(none)" ? 0.9 : 0.8)
    }
    const label = labels[Number(optionIndex)]!.toLowerCase()
    const excluded = new RegExp(`(except|not|without)\\s+(\\w+\\s+)?${escapeRegExp(label)}`).test(text)
    return answers.choice(question, !text.includes(label) ? "none" : excluded ? "exclude" : "include", 0.9)
  }).gateway
}
