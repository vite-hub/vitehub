import { ask, defineAgent, type AgentDefinition, type AgentInvokerProfile, type AgentInvocationContextValues, type AgentRuntimeConfig, type ConfiguredAgentDefinition } from "../index.ts"
import { gmail } from "../channels.ts"
import type { GmailClient, GmailLabelSettings, GmailMessage } from "../channels.ts"
import { channelMessageContextKey } from "../internal/channel-delivery-handlers.ts"
import { hasRuntimeType, isRuntimeObject } from "@vite-hub/runtime/internal/runtime-type"

export interface LabellerLabel extends GmailLabelSettings {}

export type LabellerPattern = string | readonly string[]

export interface LabellerRule {
  from?: LabellerPattern
  to?: LabellerPattern
  subject?: LabellerPattern
  body?: LabellerPattern
  listId?: LabellerPattern
  hasLabel?: LabellerPattern
  header?: Readonly<Record<string, LabellerPattern>>
  not?: LabellerRule
  label?: string
  archive?: boolean
  read?: boolean
  star?: boolean
  trash?: boolean
}

export interface LabellerAction {
  archive?: boolean
  read?: boolean
  star?: boolean
  trash?: boolean
}

export interface LabellerOptions {
  labels: Readonly<Record<string, LabellerLabel>>
  rules: Readonly<Record<string, LabellerRule>>
  actions: Readonly<Record<string, LabellerAction>>
  bodyLimit: number
  dryRun: boolean
  minConfidence: number
  trashEnabled: boolean
  client?: GmailClient
}

export interface LabellerDecision {
  label: string
  rule?: string
}

type LabellerResult = {
  label: string | { choice?: unknown, confidence?: unknown, probabilities?: Record<string, unknown> }
  rule?: string
}

const maxBodyLimit = 100_000
const maxPatternLength = 256
const maxHeaderValueLength = 1_000
const reservedLabels = new Set(["NONE", "INBOX", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT", "SENT", "DRAFT", "ALL", "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS"])

function validateLabels(labels: Readonly<Record<string, LabellerLabel>>): void {
  if (!isRuntimeObject(labels) || Array.isArray(labels)) throw new TypeError("[vitehub] Labeller labels must be an object.")
  for (const [name, value] of Object.entries(labels)) {
    if (!name.trim() || name.length > 225 || /\p{Cc}/u.test(name) || reservedLabels.has(name.toUpperCase())) {
      throw new TypeError(`[vitehub] Labeller label "${name}" is reserved or invalid.`)
    }
    if (!isRuntimeObject(value) || Array.isArray(value)) throw new TypeError(`[vitehub] Labeller label "${name}" must be an object.`)
  }
}

function patternList(value: LabellerPattern | undefined): readonly string[] | undefined {
  if (value === undefined) return
  const values = Array.isArray(value) ? value : [value]
  if (!values.length || values.some(item => !hasRuntimeType(item, "string") || item.length === 0 || item.length > maxPatternLength)) {
    throw new TypeError(`[vitehub] Labeller patterns must be non-empty strings of at most ${maxPatternLength} characters.`)
  }
  return values
}

function compilePattern(value: string): RegExp | undefined {
  const regex = /^\/(.*)\/([a-z]*)$/.exec(value)
  if (!regex) return
  if (regex[1]!.length > maxPatternLength || /[^imsu]/.test(regex[2]!)) {
    throw new TypeError("[vitehub] Labeller regex patterns use only bounded syntax and the i, m, s, and u flags.")
  }
  const source = regex[1]!
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (character === "\\") {
      const escaped = source[++index]
      if (!escaped || !"\\^$.*+?()[]{}|/".includes(escaped)) {
        throw new TypeError("[vitehub] Labeller regex patterns may only escape literal regex characters.")
      }
    }
    else if ("()[]{}*+?".includes(character)) {
      throw new TypeError("[vitehub] Labeller regex patterns may not use repetition or grouping.")
    }
  }
  try { return new RegExp(source, regex[2]!) }
  catch { throw new TypeError("[vitehub] Labeller regex pattern is invalid.") }
}

function matchesText(value: string | readonly string[], pattern: LabellerPattern | undefined): boolean {
  const patterns = patternList(pattern)
  if (!patterns) return true
  const values = Array.isArray(value) ? value : [value]
  return values.some(item => patterns.some(candidate => {
    try {
      const regex = compilePattern(candidate)
      return regex ? regex.test(item) : item.toLowerCase().includes(candidate.toLowerCase())
    }
    catch {
      return false
    }
  }))
}

function matches(message: GmailMessage, rule: LabellerRule): boolean {
  return matchesText(message.from, rule.from)
    && matchesText(message.to, rule.to)
    && matchesText(message.subject, rule.subject)
    && matchesText(message.body || message.snippet, rule.body)
    && matchesText(message.headers["list-id"] || "", rule.listId)
    && matchesText(message.labelIds, rule.hasLabel)
    && Object.entries(rule.header || {}).every(([name, value]) => matchesText(message.headers[name.toLowerCase()] || "", value))
    && (!rule.not || !matches(message, rule.not))
}

function explicitAction(rule: LabellerRule | undefined): LabellerAction {
  if (!rule) return {}
  const action: LabellerAction = {}
  for (const key of ["archive", "read", "star", "trash"] as const) {
    if (rule[key] !== undefined) action[key] = rule[key]
  }
  return action
}

function selectedLabel(result: LabellerResult | undefined): string | undefined {
  const label = result?.label
  if (hasRuntimeType(label, "string")) return label
  const choice = label?.choice
  return hasRuntimeType(choice, "string") ? choice : undefined
}

function selectedConfidence(result: LabellerResult): number | undefined {
  if (hasRuntimeType(result.label, "string")) return 1
  const confidence = result.label.confidence
  return hasRuntimeType(confidence, "number") && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : undefined
}

function validateAction(name: string, action: LabellerAction): void {
  for (const key of ["archive", "read", "star", "trash"] as const) {
    if (action[key] !== undefined && !hasRuntimeType(action[key], "boolean")) {
      throw new TypeError(`[vitehub] Labeller ${name} ${key} must be a boolean.`)
    }
  }
}

function validateRule(name: string, rule: LabellerRule, labels: Readonly<Record<string, LabellerLabel>>, depth = 0): void {
  if (depth > 8) throw new TypeError("[vitehub] Labeller rules may nest at most eight not clauses.")
  if (!isRuntimeObject(rule)) throw new TypeError(`[vitehub] Labeller rule "${name}" must be an object.`)
  validateAction(`rule "${name}"`, rule)
  for (const field of [rule.from, rule.to, rule.subject, rule.body, rule.listId, rule.hasLabel]) {
    for (const pattern of patternList(field) || []) compilePattern(pattern)
  }
  for (const [header, value] of Object.entries(rule.header || {})) {
    if (!header.trim() || header.length > maxHeaderValueLength) throw new TypeError(`[vitehub] Labeller rule "${name}" has an invalid header name.`)
    for (const pattern of patternList(value) || []) compilePattern(pattern)
  }
  if (rule.label !== undefined && (!Object.hasOwn(labels, rule.label) || !rule.label.trim())) {
    throw new TypeError(`[vitehub] Labeller rule "${name}" refers to an undeclared label.`)
  }
  if (rule.label === undefined && (rule.archive === true || rule.read === true || rule.star === true || rule.trash === true)) {
    throw new TypeError(`[vitehub] Labeller rule "${name}" must declare a label before enabling actions.`)
  }
  if (rule.not) validateRule(`${name}.not`, rule.not, labels, depth + 1)
}

function validateOptions(options: LabellerOptions): void {
  for (const key of ["dryRun", "trashEnabled"] as const) {
    if (!hasRuntimeType(options[key], "boolean")) throw new TypeError(`[vitehub] Labeller ${key} must be a boolean.`)
  }
  validateLabels(options.labels)
  const labelCount = Object.keys(options.labels).length
  if (labelCount < 1 || labelCount > 254) throw new TypeError("[vitehub] Labeller labels must contain between 1 and 254 labels.")
  if (!Number.isSafeInteger(options.bodyLimit) || options.bodyLimit < 1 || options.bodyLimit > maxBodyLimit) {
    throw new TypeError(`[vitehub] Labeller bodyLimit must be an integer from 1 to ${maxBodyLimit}.`)
  }
  if (!Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1) {
    throw new TypeError("[vitehub] Labeller minConfidence must be between 0 and 1.")
  }
  if (!isRuntimeObject(options.rules) || Array.isArray(options.rules)) throw new TypeError("[vitehub] Labeller rules must be an object.")
  for (const [name, rule] of Object.entries(options.rules || {})) validateRule(name, rule, options.labels)
  if (!isRuntimeObject(options.actions) || Array.isArray(options.actions)) throw new TypeError("[vitehub] Labeller actions must be an object.")
  for (const [label, action] of Object.entries(options.actions || {})) {
    if (!Object.hasOwn(options.labels, label)) throw new TypeError(`[vitehub] Labeller action "${label}" refers to an undeclared label.`)
    if (!isRuntimeObject(action) || Array.isArray(action)) throw new TypeError(`[vitehub] Labeller action "${label}" must be an object.`)
    validateAction(`action "${label}"`, action)
  }
}

function decision(message: GmailMessage, rules: Readonly<Record<string, LabellerRule>>): LabellerDecision | undefined {
  for (const [name, rule] of Object.entries(rules || {})) {
    if (matches(message, rule)) return { label: rule.label || "none", rule: name }
  }
}

type LabellerDefinition = AgentDefinition<AgentRuntimeConfig, unknown, AgentInvokerProfile, AgentInvocationContextValues, LabellerResult | LabellerDecision>
export type LabellerAgent = ConfiguredAgentDefinition<LabellerOptions, LabellerDefinition>

// defineAgent materializes the template once before consumers supply their options.
let materializingTemplate = true

/** Gmail labelling preset: ordered rules first, then a constrained Jev choice. */
export const labeller: LabellerAgent = defineAgent({
  options: {
    // SAFETY: The preset stores empty label and rule registries until consumer configuration validates them.
    labels: {} as Readonly<Record<string, LabellerLabel>>,
    // SAFETY: Rule entries receive their domain shape during consumer validation.
    rules: {} as Readonly<Record<string, LabellerRule>>,
    // SAFETY: Consumer validation checks each label action before it is used.
    actions: {} as Readonly<Record<string, LabellerAction>>,
    bodyLimit: 10_000,
    // Safe for notifications and first replays. Set false only when writes are intended.
    dryRun: true,
    minConfidence: 0.6,
    trashEnabled: false,
    client: undefined,
  },
  configure: (options): LabellerDefinition => {
    if (materializingTemplate) {
      materializingTemplate = false
      return defineAgent({
        driver: { run: (): LabellerResult => { throw new TypeError("[vitehub] Labeller labels must contain between 1 and 254 labels.") } },
        intercept: (): LabellerDecision | undefined => undefined,
      })
    }
    validateOptions(options)
    const { labels, rules, actions, bodyLimit, minConfidence, trashEnabled, client } = options
    // Push deliveries inherit the safe default; replay callers still choose dry-run per invocation.
    const channel = gmail({ labels, bodyLimit, client, ...(options.dryRun ? { dryRun: true } : {}) })
    return defineAgent({
      description: "Label Gmail messages with ordered rules, then a constrained Jev choice.",
      channels: { gmail: channel },
      intercept: ({ context }) => {
        // SAFETY: The Gmail Channel places its validated GmailMessage at this owned context key.
        const message = context.get(channelMessageContextKey) as GmailMessage | undefined
        const selected = message ? decision(message, rules) : undefined
        return selected ? selected : undefined
      },
      driver: {
        ask: {
          label: ask.choice(
            "Choose the Gmail label that best fits this email. Choose none when no declared label clearly fits.",
            { ...Object.fromEntries(Object.entries(labels).map(([name, value]) => [name, value.description || name])), none: "No declared label clearly fits this email." },
          ),
        },
      },
      hooks: {
        async "agent:finish"({ message, result }) {
          if (message?.channel !== "gmail" || !result) return
          // SAFETY: The owned Jev choice or ordered-rule intercept produces the Labeller result contract.
          const output = result as LabellerResult
          const label = selectedLabel(output)
          if (!label || label === "none" || !Object.hasOwn(labels, label)) return
          const confidence = selectedConfidence(output)
          if (confidence === undefined || confidence < minConfidence) return
          const rule = output.rule ? rules[output.rule] : undefined
          const selectedAction = { ...actions[label], ...(rule?.label === label ? explicitAction(rule) : {}) }
          await message.label(label)
          if (selectedAction.archive) await message.archive()
          if (selectedAction.read) await message.markRead()
          if (selectedAction.star) await message.star()
          if (selectedAction.trash && trashEnabled) await message.trash()
        },
      },
    })
  },
})
