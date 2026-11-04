import { ask } from "@vite-hub/gateways"

import { decisionsDiagnostics } from "./diagnostics.ts"

import type { AskAnswers, AskQuestion, AskQuestions } from "@vite-hub/gateways"
import type {
  ChoiceGroup,
  ChoiceGroups,
  ChoiceOption,
  ChoiceValue,
  Choices,
  ChoicesArgs,
  ChoicesDefinition,
  ChoicesError,
  ChoicesLimits,
  ChoicesPlan,
  GroupsContext,
  ChoicesResult,
  ChoicesSelection,
  MultipleSelection,
  SingleSelection,
} from "./types.ts"

const defaultLimits: ChoicesLimits = { groups: 40, options: 100, text: 300, totalOptions: 100 }
const defaultThresholds = { option: 0.5, supported: 0.6 }
/** The label of "no option" in a single group. Option labels cannot use it. */
const noneLabel = "(none)"

const includeCriteria = "Choose include when the text names this option or clearly refers to it by a common abbreviation, code, partial name, spelling error, synonym, prefix, or suffix. Match the closest specific option. Partial text alone is not permission to include neighboring options. Match each requested option independently."
const excludeCriteria = "Choose exclude only when the text directly says to omit this option, for example with except, without, not, or exclude. A negated family, prefix, or suffix excludes every matching option."
const noneCriteria = "Choose none when the text does not mention this option. Do not infer options from context or from other options. Unspecified options stay none even when another option is included or excluded."

const supportedTrue = "Every constraint in the text can be expressed with the listed options, including several options in one group, constraints across groups, exclusions, and a prefix or suffix that matches several options. Accept fragments, omitted group names, shorthand, and typos when a real option matches."
const supportedFalse = "The text needs a value or a capability that the options do not have, such as a numeric comparison, an unknown name, or OR between different groups. Also false when the text names no option at all. Do not reject a recognizable option because of shorthand or a minor typo."

interface LoadedGroup {
  group: ChoiceGroup
  key: string
  multiple: boolean
  options: readonly ChoiceOption[]
}

type Loaded = { error: ChoicesError } | { groups: LoadedGroup[] }

function define(message: string): never {
  throw decisionsDiagnostics.DECISIONS_R0001({ message: `[vitehub] ${message}` })
}

function fail(code: "DECISIONS_R0002" | "DECISIONS_R0003" | "DECISIONS_R0004" | "DECISIONS_R0006", message: string): ChoicesError {
  return decisionsDiagnostics[code]({ message: `[vitehub] ${message}` })
}

function probability(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function checkDefinition(definition: ChoicesDefinition<ChoiceGroups>, limits: ChoicesLimits, thresholds: Required<NonNullable<ChoicesDefinition<ChoiceGroups>["thresholds"]>>): void {
  if (typeof definition.gateway?.ask !== "function") define("defineChoices() needs a gateway with ask(), such as typesafe() or vercel() from vite-hub/gateways.")
  const entries = Object.entries(definition.groups ?? {})
  if (!entries.length) define("defineChoices() needs at least one group.")
  if (entries.length > limits.groups) define(`defineChoices() has ${entries.length} groups. The limit is ${limits.groups}.`)
  for (const [key, group] of entries) {
    if (typeof group?.label !== "string" || !group.label.trim()) define(`Group "${key}" needs a label.`)
    if (!Array.isArray(group.options) && typeof group.options !== "function") define(`Group "${key}" options must be a list or a function.`)
    if (group.multiple !== undefined && typeof group.multiple !== "boolean") define(`Group "${key}" multiple must be true or false.`)
  }
  for (const [name, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) define(`thresholds.${name} must be a number from 0 to 1.`)
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) define(`limits.${name} must be a positive integer.`)
  }
}

async function loadGroups(definition: ChoicesDefinition<ChoiceGroups>, limits: ChoicesLimits, context: unknown): Promise<Loaded> {
  const keys = Object.keys(definition.groups)
  const loaded: LoadedGroup[] = []
  let total = 0
  for (const key of keys) {
    const group = definition.groups[key]!
    let options: readonly ChoiceOption[]
    try {
      // SAFETY: An `options` function receives the `context` of the request. `resolve()` types it from the function parameter.
      options = typeof group.options === "function" ? await group.options(context as never) : group.options
    }
    catch (cause) {
      return { error: decisionsDiagnostics.DECISIONS_R0002({ message: `[vitehub] The options of group "${key}" failed to load.`, cause }) }
    }
    if (options.length > limits.options) return { error: fail("DECISIONS_R0002", `Group "${key}" has ${options.length} options. The limit is ${limits.options}. Narrow the options before you ask.`) }
    const multiple = group.multiple !== false
    const values = new Set<ChoiceValue>()
    const labels = new Set<string>()
    for (const option of options) {
      if (typeof option.label !== "string" || !option.label.trim()) return { error: fail("DECISIONS_R0002", `An option of group "${key}" has no label.`) }
      if (values.has(option.value)) return { error: fail("DECISIONS_R0002", `Group "${key}" has the value ${JSON.stringify(option.value)} twice. Values must be unique within a group.`) }
      values.add(option.value)
      if (!multiple) {
        if (option.label === noneLabel || labels.has(option.label)) return { error: fail("DECISIONS_R0002", `Group "${key}" is single-select, so labels must be unique and cannot be "${noneLabel}". Found "${option.label}".`) }
        labels.add(option.label)
      }
    }
    total += options.length
    loaded.push({ group, key, multiple, options })
  }
  if (total === 0) return { error: fail("DECISIONS_R0002", "No group has options. Nothing can be asked.") }
  if (total > limits.totalOptions) return { error: fail("DECISIONS_R0002", `The groups have ${total} options. The limit is ${limits.totalOptions}. Narrow the options before you ask.`) }
  return { groups: loaded }
}

function describe(option: ChoiceOption): string {
  return option.aliases?.length ? `${option.label} (also ${option.aliases.map(alias => JSON.stringify(alias)).join(", ")})` : option.label
}

function optionInstructions(group: LoadedGroup, option: ChoiceOption, hints: string): string {
  return [
    `For the ${JSON.stringify(group.group.label)} group, does the text directly request or directly negate the option ${JSON.stringify(describe(option))} (value ${JSON.stringify(option.value)})?`,
    "Evaluate this option separately from all others. A requested prefix or suffix applies to every matching option. If the text names a different group for a phrase, do not reuse that phrase to select this option.",
    group.group.hints,
    hints,
  ].filter(Boolean).join(" ")
}

function singleInstructions(group: LoadedGroup, hints: string): string {
  return [
    `For the ${JSON.stringify(group.group.label)} group, which one option does the text choose?`,
    `Choose ${JSON.stringify(noneLabel)} when the text does not name an option of this group. Do not infer an option from context or from other groups.`,
    group.group.hints,
    hints,
  ].filter(Boolean).join(" ")
}

function buildPlan(text: string, groups: readonly LoadedGroup[], hints: string): ChoicesPlan {
  const questions: Record<string, AskQuestion> = {
    supported: ask.chance("Can all intended constraints in the text be expressed with the supplied options? Be permissive about ordinary phrasing, shorthand, prefixes, and typos, but require a real match to supplied options.", { false: supportedFalse, true: supportedTrue }),
  }
  groups.forEach((group, groupIndex) => {
    if (!group.options.length) return
    if (group.multiple) {
      group.options.forEach((option, optionIndex) => {
        questions[`g${groupIndex}_o${optionIndex}`] = ask.choice(optionInstructions(group, option, hints), { exclude: excludeCriteria, include: includeCriteria, none: noneCriteria })
      })
      return
    }
    questions[`g${groupIndex}`] = ask.choice(
      singleInstructions(group, hints),
      { ...Object.fromEntries(group.options.map(option => [option.label, option.aliases?.length ? `Also called ${option.aliases.join(", ")}.` : null])), [noneLabel]: "The text does not name an option of this group." },
    )
  })
  return {
    questions,
    state: {
      groups: groups.map(group => ({
        ...(group.group.hints ? { hints: group.group.hints } : {}),
        label: group.group.label,
        multiple: group.multiple,
        options: group.options.map(option => ({ ...(option.aliases?.length ? { aliases: option.aliases } : {}), label: option.label, value: option.value })),
      })),
      query: text,
    },
  }
}

function readSelection(answers: AskAnswers<AskQuestions>, groups: readonly LoadedGroup[], threshold: number): ChoicesResult<Record<string, MultipleSelection | SingleSelection>> {
  const selection: Record<string, MultipleSelection | SingleSelection> = {}
  for (const [groupIndex, group] of groups.entries()) {
    if (!group.multiple) {
      const answer = answers[`g${groupIndex}`]
      if (!group.options.length) {
        selection[group.key] = { confidence: 0, ranked: [], value: null }
        continue
      }
      if (typeof answer !== "object" || answer.type !== "choice") return [fail("DECISIONS_R0006", `The model did not answer the group "${group.key}".`)]
      const byLabel = new Map(group.options.map(option => [option.label, option.value]))
      const ranked = [...byLabel].map(([label, value]) => ({ probability: probability(Reflect.get(answer.probabilities, label)), value })).sort((a, b) => b.probability - a.probability)
      const best = ranked[0]
      const chosen = answer.choice === noneLabel ? undefined : byLabel.get(answer.choice)
      selection[group.key] = { confidence: probability(answer.confidence), ranked, value: chosen !== undefined && best && probability(Reflect.get(answer.probabilities, answer.choice)) >= threshold ? chosen : null }
      continue
    }
    const include: ChoiceValue[] = []
    const exclude: ChoiceValue[] = []
    for (const [optionIndex, option] of group.options.entries()) {
      const answer = answers[`g${groupIndex}_o${optionIndex}`]
      if (typeof answer !== "object" || answer.type !== "choice") return [fail("DECISIONS_R0006", `The model did not answer the option "${option.label}" of group "${group.key}".`)]
      if (answer.choice === "none" || probability(Reflect.get(answer.probabilities, answer.choice)) < threshold) continue
      if (answer.choice === "include") include.push(option.value)
      else exclude.push(option.value)
    }
    selection[group.key] = { exclude, include }
  }
  return [undefined, selection]
}

/**
 * Declares the options that text can choose from, and how to ask a gateway about them.
 * Nothing here knows your UI, your routes, or your store. Call `resolve()` wherever you run server code.
 */
export function defineChoices<const TGroups extends ChoiceGroups>(definition: ChoicesDefinition<TGroups>): Choices<TGroups> {
  const limits: ChoicesLimits = { ...defaultLimits, ...definition.limits }
  const thresholds = { ...defaultThresholds, ...definition.thresholds }
  const base: ChoicesDefinition<ChoiceGroups> = definition
  checkDefinition(base, limits, thresholds)
  const hints = definition.hints?.trim() ?? ""

  async function prepare(text: string, request: { context?: unknown, signal?: AbortSignal } | undefined): Promise<ChoicesResult<{ groups: LoadedGroup[], plan: ChoicesPlan, text: string }>> {
    const trimmed = typeof text === "string" ? text.trim() : ""
    if (!trimmed) return [fail("DECISIONS_R0003", "The text is empty. Nothing was asked.")]
    if (trimmed.length > limits.text) return [fail("DECISIONS_R0003", `The text has ${trimmed.length} characters. The limit is ${limits.text}.`)]
    const loaded = await loadGroups(base, limits, request?.context)
    if ("error" in loaded) return [loaded.error]
    return [undefined, { groups: loaded.groups, plan: buildPlan(trimmed, loaded.groups, hints), text: trimmed }]
  }

  return {
    async inspect(text: string, ...args: ChoicesArgs<GroupsContext<TGroups>>): Promise<ChoicesResult<ChoicesPlan>> {
      const [error, prepared] = await prepare(text, args[0])
      return error ? [error] : [undefined, prepared.plan]
    },
    name: definition.name,
    async resolve(text: string, ...args: ChoicesArgs<GroupsContext<TGroups>>): Promise<ChoicesResult<ChoicesSelection<TGroups>>> {
      const request = args[0]
      const [error, prepared] = await prepare(text, request)
      if (error) return [error]
      let answers: AskAnswers<AskQuestions>
      try {
        // SAFETY: The plan questions come from the `ask` builders.
        answers = await definition.gateway.ask(prepared.plan.state, prepared.plan.questions as AskQuestions, { signal: request?.signal })
      }
      catch (cause) {
        return [decisionsDiagnostics.DECISIONS_R0005({ message: "[vitehub] The gateway request failed.", cause })]
      }
      const supported = answers.supported
      if (typeof supported !== "object" || supported.type !== "chance") return [fail("DECISIONS_R0006", "The model did not answer the supported check.")]
      if (probability(supported.chance) < thresholds.supported) return [fail("DECISIONS_R0004", "The options cannot express that text. Try another name, or use the options directly.")]
      const [readError, selection] = readSelection(answers, prepared.groups, thresholds.option)
      if (readError) return [readError]
      // SAFETY: readSelection builds one entry per group with the shape of its `multiple` setting.
      return [undefined, selection as ChoicesSelection<TGroups>]
    },
  }
}
