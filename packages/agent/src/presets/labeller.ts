import { ask, defineAgent, type AgentDefinition, type AgentInvokerProfile, type AgentInvocationContextValues, type AgentRuntimeConfig, type ConfiguredAgentDefinition } from "../index.ts"
import { gmail } from "../channels.ts"
import type { GmailClient, GmailLabelSettings, GmailMessage } from "../channels.ts"
import { channelMessageContextKey } from "../internal/channel-delivery-handlers.ts"

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
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) throw new TypeError("[vitehub] Labeller labels must be an object.")
  for (const [name, value] of Object.entries(labels)) {
    if (!name.trim() || name.length > 225 || /[\u0000-\u001f\u007f]/.test(name) || reservedLabels.has(name.toUpperCase())) {
      throw new TypeError(`[vitehub] Labeller label "${name}" is reserved or invalid.`)
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`[vitehub] Labeller label "${name}" must be an object.`)
  }
}

function patternList(value: LabellerPattern | undefined): readonly string[] | undefined {
  if (value === undefined) return
  const values = Array.isArray(value) ? value : [value]
  if (!values.length || values.some(item => typeof item !== "string" || item.length === 0 || item.length > maxPatternLength)) {
    throw new TypeError(`[vitehub] Labeller patterns must be non-empty strings of at most ${maxPatternLength} characters.`)
  }
  return values
}

function matchesText(value: string | readonly string[], pattern: LabellerPattern | undefined): boolean {
  const patterns = patternList(pattern)
  if (!patterns) return true
  const values = Array.isArray(value) ? value : [value]
  return values.some(item => patterns.some(candidate => {
    const regex = /^\/(.*)\/([a-z]*)$/.exec(candidate)
    if (!regex) return item.toLowerCase().includes(candidate.toLowerCase())
    if (regex[1]!.length > maxPatternLength || /[^imsu]/.test(regex[2]!)) return false
    try {
      return new RegExp(regex[1]!, regex[2]!).test(item)
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
  if (typeof result?.label === "string") return result.label
  return typeof result?.label?.choice === "string" ? result.label.choice : undefined
}

function selectedConfidence(result: LabellerResult): number | undefined {
  if (typeof result.label === "string") return 1
  const confidence = result.label.confidence
  return typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : undefined
}

function validateRule(name: string, rule: LabellerRule, labels: Readonly<Record<string, LabellerLabel>>, depth = 0): void {
  if (depth > 8) throw new TypeError("[vitehub] Labeller rules may nest at most eight not clauses.")
  if (!rule || typeof rule !== "object") throw new TypeError(`[vitehub] Labeller rule "${name}" must be an object.`)
  for (const field of [rule.from, rule.to, rule.subject, rule.body, rule.listId, rule.hasLabel]) patternList(field)
  for (const [header, value] of Object.entries(rule.header || {})) {
    if (!header.trim() || header.length > maxHeaderValueLength) throw new TypeError(`[vitehub] Labeller rule "${name}" has an invalid header name.`)
    patternList(value)
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
  validateLabels(options.labels)
  if (!Number.isSafeInteger(options.bodyLimit) || options.bodyLimit < 1 || options.bodyLimit > maxBodyLimit) {
    throw new TypeError(`[vitehub] Labeller bodyLimit must be an integer from 1 to ${maxBodyLimit}.`)
  }
  if (!Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1) {
    throw new TypeError("[vitehub] Labeller minConfidence must be between 0 and 1.")
  }
  if (!options.rules || typeof options.rules !== "object" || Array.isArray(options.rules)) throw new TypeError("[vitehub] Labeller rules must be an object.")
  for (const [name, rule] of Object.entries(options.rules || {})) validateRule(name, rule, options.labels)
  if (!options.actions || typeof options.actions !== "object" || Array.isArray(options.actions)) throw new TypeError("[vitehub] Labeller actions must be an object.")
  for (const [label, action] of Object.entries(options.actions || {})) {
    if (!Object.hasOwn(options.labels, label)) throw new TypeError(`[vitehub] Labeller action "${label}" refers to an undeclared label.`)
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new TypeError(`[vitehub] Labeller action "${label}" must be an object.`)
  }
}

function decision(message: GmailMessage, rules: Readonly<Record<string, LabellerRule>>): LabellerDecision | undefined {
  for (const [name, rule] of Object.entries(rules || {})) {
    if (matches(message, rule)) return { label: rule.label || "none", rule: name }
  }
}

type LabellerDefinition = AgentDefinition<AgentRuntimeConfig, unknown, AgentInvokerProfile, AgentInvocationContextValues, LabellerResult | LabellerDecision>
export type LabellerAgent = ConfiguredAgentDefinition<LabellerOptions, LabellerDefinition>

/** Gmail labelling preset: ordered rules first, then a constrained Jev choice. */
export const labeller: LabellerAgent = defineAgent({
  options: {
    labels: {} as Readonly<Record<string, LabellerLabel>>,
    rules: {} as Readonly<Record<string, LabellerRule>>,
    actions: {} as Readonly<Record<string, LabellerAction>>,
    bodyLimit: 10_000,
    // Safe for notifications and first replays. Set false only when writes are intended.
    dryRun: true,
    minConfidence: 0.6,
    trashEnabled: false,
    client: undefined,
  },
  configure: options => {
    validateOptions(options)
    const { labels, rules, actions, bodyLimit, dryRun, minConfidence, trashEnabled, client } = options
    const channel = gmail({ labels, bodyLimit, dryRun, client })
    return defineAgent({
      description: "Label Gmail messages with ordered rules, then a constrained Jev choice.",
      channels: { gmail: channel },
      intercept: ({ context }) => {
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
