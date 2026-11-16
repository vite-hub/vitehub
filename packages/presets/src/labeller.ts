import { ask } from "@vite-hub/gateways"
import { defineAgent, type AgentDefinition, type AgentInvoker, type AgentInvocationContextValues, type AgentRuntimeConfig, type ConfiguredAgentDefinition } from "@vite-hub/agent"
import { gmail, gmailClient } from "@vite-hub/agent/channels"
import type { AgentRuntimeContext } from "@vite-hub/agent"
import type { GmailChannelOptions, GmailClient, GmailLabelSettings, GmailMessage } from "@vite-hub/agent/channels"
import { channelMessageContextKey } from "@vite-hub/agent/channels"
import * as v from "valibot"
import { hasRuntimeType, isRuntimeObject } from "@vite-hub/runtime/internal/runtime-type"
import { presetsErrorDiagnostics } from "./error-diagnostics.ts"
import { isRuntimeRecord } from "./internal/runtime-type.ts"

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

/** Moves mail with a declared `label` that is older than `olderThan` days to Trash. Starred mail stays. */
export interface LabellerCleanupRule {
  /** Gmail label name. Nested labels use `Parent/Child`. */
  label: string
  /** Age in whole days. */
  olderThan: number
}

export interface LabellerOptions {
  /** Labels the Agent may set. Jev chooses only among labels with a `description`; a label without one is set only by rules. */
  labels: Readonly<Record<string, LabellerLabel>>
  rules: Readonly<Record<string, LabellerRule>>
  actions: Readonly<Record<string, LabellerAction>>
  cleanup: Readonly<Record<string, LabellerCleanupRule>>
  bodyLimit: number
  dryRun: boolean
  /** Hide Gmail labels that `labels` does not declare from Gmail's label list when `vitehub channels sync` applies. */
  hideUnmanagedLabels: boolean
  /** Syncs that try one failing message before the Gmail Channel skips it. Defaults to the Channel's 5. */
  maxAttempts?: number
  minConfidence: number
  /**
   * Remove the other declared labels when a message gets its label, and every declared label when no label fits.
   * Use it to correct earlier labels with a replay. Defaults to `false`, which only adds a label.
   */
  relabel: boolean
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
  if (!isRuntimeObject(labels) || Array.isArray(labels)) throw presetsErrorDiagnostics.PRESETS_LABELLER_LABELS_INVALID()
  for (const [name, value] of Object.entries(labels)) {
    if (!name.trim() || name.length > 225 || /\p{Cc}/u.test(name) || reservedLabels.has(name.toUpperCase())) {
      throw presetsErrorDiagnostics.PRESETS_LABELLER_LABEL_NAME_INVALID({ name })
    }
    if (!isRuntimeObject(value) || Array.isArray(value)) throw presetsErrorDiagnostics.PRESETS_LABELLER_LABEL_SETTINGS_INVALID({ name })
  }
}

function patternList(value: LabellerPattern | undefined): readonly string[] | undefined {
  if (value === undefined) return
  const values = Array.isArray(value) ? value : [value]
  if (!values.length || values.some(item => !hasRuntimeType(item, "string") || item.length === 0 || item.length > maxPatternLength)) {
    throw presetsErrorDiagnostics.PRESETS_LABELLER_PATTERN_INVALID({ max: maxPatternLength })
  }
  return values
}

function compilePattern(value: string): RegExp | undefined {
  const regex = /^\/(.*)\/([a-z]*)$/.exec(value)
  if (!regex) return
  if (regex[1]!.length > maxPatternLength || /[^imsu]/.test(regex[2]!)) {
    throw presetsErrorDiagnostics.PRESETS_LABELLER_REGEX_FLAGS_INVALID()
  }
  const source = regex[1]!
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!
    if (character === "\\") {
      const escaped = source[++index]
      if (!escaped || !"\\^$.*+?()[]{}|/".includes(escaped)) {
        throw presetsErrorDiagnostics.PRESETS_LABELLER_REGEX_ESCAPE_INVALID()
      }
    }
    else if ("()[]{}*+?".includes(character)) {
      throw presetsErrorDiagnostics.PRESETS_LABELLER_REGEX_SYNTAX_UNSUPPORTED()
    }
  }
  try { return new RegExp(source, regex[2]!) }
  catch { throw presetsErrorDiagnostics.PRESETS_LABELLER_REGEX_INVALID() }
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
      throw presetsErrorDiagnostics.PRESETS_LABELLER_ACTION_FLAG_INVALID({ name, key })
    }
  }
}

function validateRule(name: string, rule: LabellerRule, labels: Readonly<Record<string, LabellerLabel>>, depth = 0): void {
  if (depth > 8) throw presetsErrorDiagnostics.PRESETS_LABELLER_RULE_NESTING_TOO_DEEP()
  if (!isRuntimeObject(rule)) throw presetsErrorDiagnostics.PRESETS_LABELLER_RULE_INVALID({ name })
  validateAction(`rule "${name}"`, rule)
  for (const field of [rule.from, rule.to, rule.subject, rule.body, rule.listId, rule.hasLabel]) {
    for (const pattern of patternList(field) || []) compilePattern(pattern)
  }
  for (const [header, value] of Object.entries(rule.header || {})) {
    if (!header.trim() || header.length > maxHeaderValueLength) throw presetsErrorDiagnostics.PRESETS_LABELLER_RULE_HEADER_INVALID({ name })
    for (const pattern of patternList(value) || []) compilePattern(pattern)
  }
  if (rule.label !== undefined && (!Object.hasOwn(labels, rule.label) || !rule.label.trim())) {
    throw presetsErrorDiagnostics.PRESETS_LABELLER_RULE_LABEL_UNDECLARED({ name })
  }
  if (rule.label === undefined && (rule.archive === true || rule.read === true || rule.star === true || rule.trash === true)) {
    throw presetsErrorDiagnostics.PRESETS_LABELLER_RULE_LABEL_MISSING({ name })
  }
  if (rule.not) validateRule(`${name}.not`, rule.not, labels, depth + 1)
}

function validateOptions(options: LabellerOptions): void {
  for (const key of ["dryRun", "hideUnmanagedLabels", "relabel", "trashEnabled"] as const) {
    if (!hasRuntimeType(options[key], "boolean")) throw presetsErrorDiagnostics.PRESETS_LABELLER_OPTION_NOT_BOOLEAN({ key })
  }
  validateLabels(options.labels)
  const labelCount = Object.keys(options.labels).length
  if (labelCount < 1 || labelCount > 254) throw presetsErrorDiagnostics.PRESETS_LABELLER_LABEL_COUNT_INVALID()
  if (!Number.isSafeInteger(options.bodyLimit) || options.bodyLimit < 1 || options.bodyLimit > maxBodyLimit) {
    throw presetsErrorDiagnostics.PRESETS_LABELLER_BODY_LIMIT_INVALID({ max: maxBodyLimit })
  }
  if (!Number.isFinite(options.minConfidence) || options.minConfidence < 0 || options.minConfidence > 1) {
    throw presetsErrorDiagnostics.PRESETS_LABELLER_MIN_CONFIDENCE_INVALID()
  }
  if (!isRuntimeObject(options.rules) || Array.isArray(options.rules)) throw presetsErrorDiagnostics.PRESETS_LABELLER_RULES_INVALID()
  for (const [name, rule] of Object.entries(options.rules || {})) validateRule(name, rule, options.labels)
  if (!isRuntimeObject(options.actions) || Array.isArray(options.actions)) throw presetsErrorDiagnostics.PRESETS_LABELLER_ACTIONS_INVALID()
  for (const [label, action] of Object.entries(options.actions || {})) {
    if (!Object.hasOwn(options.labels, label)) throw presetsErrorDiagnostics.PRESETS_LABELLER_ACTION_LABEL_UNDECLARED({ label })
    if (!isRuntimeObject(action) || Array.isArray(action)) throw presetsErrorDiagnostics.PRESETS_LABELLER_ACTION_INVALID({ label })
    validateAction(`action "${label}"`, action)
  }
  if (!isRuntimeObject(options.cleanup) || Array.isArray(options.cleanup)) throw presetsErrorDiagnostics.PRESETS_LABELLER_CLEANUP_INVALID()
  for (const [name, rule] of Object.entries(options.cleanup)) {
    if (!isRuntimeObject(rule) || !hasRuntimeType(rule.label, "string") || !Object.hasOwn(options.labels, rule.label)) {
      throw presetsErrorDiagnostics.PRESETS_LABELLER_CLEANUP_LABEL_UNDECLARED({ name })
    }
    if (/["\\\p{Cc}]/u.test(rule.label)) {
      throw presetsErrorDiagnostics.PRESETS_LABELLER_CLEANUP_LABEL_NAME_INVALID({ name })
    }
    if (!Number.isSafeInteger(rule.olderThan) || rule.olderThan < 1) {
      throw presetsErrorDiagnostics.PRESETS_LABELLER_CLEANUP_OLDER_THAN_INVALID({ name })
    }
  }
}

function decision(message: GmailMessage, rules: Readonly<Record<string, LabellerRule>>): LabellerDecision | undefined {
  for (const [name, rule] of Object.entries(rules || {})) {
    if (matches(message, rule)) return { label: rule.label || "none", rule: name }
  }
}

type LabellerDefinition = AgentDefinition<AgentRuntimeConfig, unknown, AgentInvoker, AgentInvocationContextValues, LabellerResult | LabellerDecision>
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
    // SAFETY: Consumer validation checks each cleanup rule against the declared labels.
    cleanup: {} as Readonly<Record<string, LabellerCleanupRule>>,
    bodyLimit: 10_000,
    // Safe for notifications and first replays. Set false only when writes are intended.
    dryRun: true,
    hideUnmanagedLabels: false,
    maxAttempts: undefined,
    minConfidence: 0.6,
    relabel: false,
    trashEnabled: false,
    client: undefined,
  },
  configure: (options): LabellerDefinition => {
    if (materializingTemplate) {
      materializingTemplate = false
      return defineAgent({
        driver: { run: (): LabellerResult => { throw presetsErrorDiagnostics.PRESETS_LABELLER_LABEL_COUNT_INVALID() } },
        intercept: (): LabellerDecision | undefined => undefined,
      })
    }
    validateOptions(options)
    const { labels, rules, actions, bodyLimit, hideUnmanagedLabels, maxAttempts, minConfidence, relabel, trashEnabled, client } = options
    // Push deliveries inherit the safe default; replay callers still choose dry-run per invocation.
    const channelOptions: GmailChannelOptions = { labels, bodyLimit, client, hideUnmanagedLabels, ...(maxAttempts === undefined ? {} : { maxAttempts }) }
    if (options.dryRun) channelOptions.dryRun = true
    const channel = gmail(channelOptions)
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
            { ...Object.fromEntries(Object.entries(labels).flatMap(([name, value]) => value.description ? [[name, value.description]] : [])), none: "No declared label clearly fits this email." },
          ),
        },
      },
      hooks: {
        async "agent:finish"({ message, result }) {
          if (message?.channel !== "gmail" || !result) return
          // SAFETY: The owned Jev choice or ordered-rule intercept produces the Labeller result contract.
          const output = result as LabellerResult
          const candidate = selectedLabel(output)
          const declared = candidate && candidate !== "none" && Object.hasOwn(labels, candidate) ? candidate : undefined
          const confidence = declared ? selectedConfidence(output) : undefined
          const label = confidence !== undefined && confidence >= minConfidence ? declared : undefined
          if (relabel) {
            const removeLabels = Object.keys(labels).filter(name => name !== label)
            await message.modify({ addLabels: label ? [label] : [], removeLabels })
          }
          if (!label) return
          const rule = output.rule ? rules[output.rule] : undefined
          const selectedAction = { ...actions[label] }
          if (rule?.label === label) Object.assign(selectedAction, explicitAction(rule))
          if (!relabel) await message.label(label)
          if (selectedAction.archive) await message.archive()
          if (selectedAction.read) await message.markRead()
          if (selectedAction.star) await message.star()
          if (selectedAction.trash && trashEnabled) await message.trash()
        },
      },
    })
  },
})

export interface CleanupLabellerOptions {
  /** Move the matches to Trash. Without it, or while the Agent has `dryRun: true` or `trashEnabled: false`, the function only lists them. */
  apply?: boolean
  /** Runtime Context for Server Env and Cloudflare bindings. Omit it outside a host request. */
  runtime?: AgentRuntimeContext
}

export interface LabellerCleanupRuleResult {
  /** IDs of the matching messages, at most 500 per rule. */
  messageIds: string[]
  /** Gmail search query of the rule. */
  query: string
  rule: string
}

export interface CleanupLabellerResult {
  applied: boolean
  rules: LabellerCleanupRuleResult[]
}

/** Gmail's largest search page. A later run finds the rest. */
const cleanupLimit = 500
const trashConcurrency = 5
const messageList = v.object({ messages: v.optional(v.array(v.object({ id: v.string() }))) })

/**
 * Runs the Labeller's `cleanup` rules on its Gmail Channel, at most 500 messages per rule.
 * Call it from a daily Schedule: each run continues with the matches that remain.
 */
export async function cleanupLabeller(agent: LabellerAgent, options: CleanupLabellerOptions = {}): Promise<CleanupLabellerResult> {
  const channel = agent.channels?.gmail
  if (!channel) throw presetsErrorDiagnostics.PRESETS_LABELLER_CLEANUP_AGENT_INVALID()
  const apply = options.apply === true && agent.options.dryRun === false && agent.options.trashEnabled === true
  const rules = Object.entries(agent.options.cleanup)
  if (!rules.length) return { applied: apply, rules: [] }
  const client = await gmailClient(channel, options.runtime ? { runtime: options.runtime } : {})
  const results: LabellerCleanupRuleResult[] = []
  for (const [rule, { label, olderThan }] of rules) {
    // Quotes keep spaces and nested label names exact.
    const query = `label:"${label}" older_than:${olderThan}d -is:starred -in:trash`
    const page = v.parse(messageList, await client({ method: "GET", path: "messages", query: { includeSpamTrash: true, maxResults: cleanupLimit, q: query } }))
    const messageIds = (page.messages ?? []).map(message => message.id)
    for (let start = 0; apply && start < messageIds.length; start += trashConcurrency) {
      await Promise.all(messageIds.slice(start, start + trashConcurrency).map(async (id) => {
        try { await client({ method: "POST", path: `messages/${encodeURIComponent(id)}/trash` }) }
        catch (error) {
          // A message deleted after the search needs no cleanup.
          if (!isRuntimeRecord(error) || error.status !== 404) throw error
        }
      }))
    }
    results.push({ messageIds, query, rule })
  }
  return { applied: apply, rules: results }
}
