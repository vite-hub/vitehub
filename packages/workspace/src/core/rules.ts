import { minimatch } from "minimatch"
import { lookup } from "mrmime"

import { workspaceError } from "./errors.ts"
import { contentToBytes, normalizeWorkspacePath } from "./path.ts"
import { workspaceDefinitionPlugins, workspacePluginsVersion } from "./plugins.ts"
import { assertWorkspaceRules, cascadingRuleKeys } from "./rule-keys.ts"

import type {
  ResolvedWorkspaceRule,
  WorkspaceDefinition,
  WorkspaceAutoCommitPlan,
  WorkspaceDiff,
  WorkspaceHookContext,
  WorkspaceHooks,
  WorkspaceRule,
  WorkspaceRules,
  WorkspaceWriteInput,
  WorkspaceWriteOperation,
  WorkspaceWriteValidator,
} from "./types.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

export interface WorkspaceWritePolicy {
  after(input: WorkspaceWriteInput): Promise<void>
  before(input: Omit<WorkspaceWriteInput, "rule">): Promise<WorkspaceWriteInput>
  check(input: Omit<WorkspaceWriteInput, "rule">): WorkspaceWriteInput
  error(input: WorkspaceWriteInput, error: unknown): Promise<void>
}

interface NormalizedWorkspacePolicy {
  hooks: WorkspaceHooks
  rules: Array<ResolvedWorkspaceRule & { specificity: number }>
}

type CascadingRuleKey = typeof cascadingRuleKeys[number]

/** The matched rule, and the pattern of the rule that set each field, for error messages. */
interface MatchedWorkspaceRule {
  origins: Partial<Record<CascadingRuleKey, string>>
  rule: ResolvedWorkspaceRule
}

function normalizeMaxBytes(value: WorkspaceRule["maxBytes"]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number") return value
  const match = /^(\d+)(kb|mb)$/.exec(value.toLowerCase())
  if (!match) throw workspaceErrorDiagnostics.WORKSPACE_R0023({ message: `[vitehub] Invalid workspace rule maxBytes value "${value}".` })
  const count = Number(match[1])
  return match[2] === "kb" ? count * 1024 : count * 1024 * 1024
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function mergeHooks(left: WorkspaceHooks = {}, right: WorkspaceHooks = {}): WorkspaceHooks {
  return {
    "write:after": [...toArray(left["write:after"]), ...toArray(right["write:after"])],
    "write:before": [...toArray(left["write:before"]), ...toArray(right["write:before"])],
    "write:error": [...toArray(left["write:error"]), ...toArray(right["write:error"])],
    "write:validate": [...toArray(left["write:validate"]), ...toArray(right["write:validate"])],
  }
}

/** Merges rules on the same pattern field by field. A later rule replaces only the fields it sets, and validators add up. */
function mergeRules(left: WorkspaceRules, right: WorkspaceRules = {}): WorkspaceRules {
  assertWorkspaceRules(right)
  const merged: WorkspaceRules = { ...left }
  for (const [pattern, rule] of Object.entries(right)) {
    const previous = merged[pattern]
    if (!previous) {
      merged[pattern] = rule
      continue
    }
    const next: WorkspaceRule = { ...previous, validate: [...toArray(previous.validate), ...toArray(rule.validate)] }
    if (rule.commit !== undefined) next.commit = rule.commit
    if (rule.maxBytes !== undefined) next.maxBytes = rule.maxBytes
    if (rule.mediaType !== undefined) next.mediaType = rule.mediaType
    if (rule.write !== undefined) next.write = rule.write
    merged[pattern] = next
  }
  return merged
}

function normalizeRules(rules: WorkspaceRules): NormalizedWorkspacePolicy["rules"] {
  return Object.entries(rules).map(([pattern, rule]) => {
    const normalizedPattern = normalizeWorkspacePath(pattern)
    return {
      ...rule,
      maxBytes: normalizeMaxBytes(rule.maxBytes),
      pattern: normalizedPattern,
      specificity: normalizedPattern.replace(/\*/g, "").length,
      validate: toArray(rule.validate),
    }
  }).sort((left, right) => left.specificity - right.specificity || left.pattern.localeCompare(right.pattern))
}

function normalizePolicy(definition: WorkspaceDefinition): NormalizedWorkspacePolicy {
  let hooks: WorkspaceHooks = {}
  let rules: WorkspaceRules = {}

  for (const plugin of workspaceDefinitionPlugins(definition)) {
    if (!plugin?.id) throw workspaceErrorDiagnostics.WORKSPACE_R0024({ message: "[vitehub] Workspace plugins require an id." })
    rules = mergeRules(rules, plugin.rules)
    hooks = mergeHooks(hooks, plugin.hooks)
  }

  rules = mergeRules(rules, definition.rules)
  hooks = mergeHooks(hooks, definition.hooks)

  return {
    hooks,
    rules: normalizeRules(rules),
  }
}

/**
 * Resolves every rule that matches the path, from the least to the most specific. A more specific rule replaces a
 * field only when it sets that field, so `"docs/**": { maxBytes }` keeps a broader `write: false`. Validators of every
 * matching rule run, the least specific first.
 */
function matchRule(policy: NormalizedWorkspacePolicy, path: string): MatchedWorkspaceRule | undefined {
  const normalized = normalizeWorkspacePath(path)
  let matched: MatchedWorkspaceRule | undefined
  for (const rule of policy.rules) {
    const globstarDirectory = rule.pattern.endsWith("/**") ? rule.pattern.slice(0, -3) : undefined
    if (!minimatch(normalized, rule.pattern, { dot: true }) && normalized !== globstarDirectory) continue
    matched ??= { origins: {}, rule: { pattern: rule.pattern, validate: [] } }
    matched.rule.pattern = rule.pattern
    matched.rule.validate = [...matched.rule.validate, ...rule.validate]
    for (const key of cascadingRuleKeys) {
      if (rule[key] === undefined) continue
      matched.origins[key] = rule.pattern
      Object.assign(matched.rule, { [key]: rule[key] })
    }
  }
  return matched
}

function writeAllowed(write: ResolvedWorkspaceRule["write"], operation: WorkspaceWriteOperation, exists: boolean) {
  if (write === undefined || write === true) return true
  if (write === false) return false
  if (write === "delete") return operation === "rm"
  if (write === "create") return operation !== "rm" && !exists
  if (write === "update") return operation === "writeFile" && exists
  return true
}

function sizeOf(content: WorkspaceWriteInput["content"]) {
  return content === undefined ? 0 : contentToBytes(content).byteLength
}

/** The media type that a file write stores: the one the caller passed, else the one its path implies. */
function writeMediaType(input: Pick<WorkspaceWriteInput, "mediaType" | "path">): string {
  return input.mediaType || lookup(input.path) || "application/octet-stream"
}

function assertRuleAllows(input: WorkspaceWriteInput, matched: MatchedWorkspaceRule | undefined) {
  if (!matched) return
  const { origins, rule } = matched

  const exists = Boolean(input.previous)
  if (!writeAllowed(rule.write, input.operation, exists)) {
    throw workspaceError(`[vitehub] Workspace rule "${origins.write}" does not allow ${input.operation} for ${input.path}.`)
  }

  if (rule.maxBytes !== undefined && sizeOf(input.content) > rule.maxBytes) {
    throw workspaceError(`[vitehub] Workspace rule "${origins.maxBytes}" limits writes to ${rule.maxBytes} bytes: ${input.path}.`)
  }

  if (rule.mediaType && input.operation === "writeFile") {
    const allowed = Array.isArray(rule.mediaType) ? rule.mediaType : [rule.mediaType]
    const mediaType = writeMediaType(input)
    if (!allowed.includes(mediaType)) {
      throw workspaceError(`[vitehub] Workspace rule "${origins.mediaType}" does not allow media type ${mediaType}: ${input.path}.`)
    }
  }
}

/** Stores the media type that the rule checked, so the stored file cannot get another type from the Store. */
function withCheckedMediaType(input: WorkspaceWriteInput, matched: MatchedWorkspaceRule | undefined): WorkspaceWriteInput {
  if (!matched?.rule.mediaType || input.operation !== "writeFile" || input.mediaType) return input
  return { ...input, mediaType: writeMediaType(input) }
}

async function runHooks(hooks: WorkspaceHooks, name: keyof WorkspaceHooks, input: WorkspaceHookContext) {
  for (const hook of toArray(hooks[name] as WorkspaceHooks[typeof name])) {
    await (hook as (ctx: WorkspaceHookContext) => void | Promise<void>)(input)
  }
}

async function runValidators(validators: WorkspaceWriteValidator[], input: WorkspaceWriteInput): Promise<WorkspaceWriteInput> {
  let current = input
  for (const validate of validators) {
    const result = await validate(current)
    if (result === false) {
      throw workspaceError(`[vitehub] Workspace validator rejected ${current.operation} for ${current.path}.`)
    }
    if (typeof result === "object" && result !== null) current = result
  }
  return current
}

export function createWorkspaceWritePolicy(definition: WorkspaceDefinition): WorkspaceWritePolicy {
  // Contributed plugins can arrive after a Workspace facade exists. Rebuild the policy when they change.
  let cached = { version: workspacePluginsVersion(), policy: normalizePolicy(definition) }
  const currentPolicy = () => {
    const version = workspacePluginsVersion()
    if (cached.version !== version) cached = { version, policy: normalizePolicy(definition) }
    return cached.policy
  }

  return {
    check(input) {
      const matched = matchRule(currentPolicy(), input.path)
      const checked = { ...input, rule: matched?.rule }
      assertRuleAllows(checked, matched)
      return withCheckedMediaType(checked, matched)
    },
    async before(input) {
      const policy = currentPolicy()
      const matched = matchRule(policy, input.path)
      const rule = matched?.rule
      let current: WorkspaceWriteInput = { ...input, rule }
      await runHooks(policy.hooks, "write:before", current)
      current = { ...current, rule }
      assertRuleAllows(current, matched)
      if (rule?.validate.length) current = await runValidators(rule.validate, current)
      await runHooks(policy.hooks, "write:validate", current)
      current = { ...current, rule }
      assertRuleAllows(current, matched)
      return withCheckedMediaType(current, matched)
    },
    async after(input) {
      await runHooks(currentPolicy().hooks, "write:after", input)
    },
    async error(input, error) {
      for (const hook of toArray(currentPolicy().hooks["write:error"])) await hook({ ...input, error })
    },
  }
}

export function resolveWorkspaceAutoCommit(definition: WorkspaceDefinition, diff: WorkspaceDiff): WorkspaceAutoCommitPlan | undefined {
  if (!diff.entries.length) return

  if (definition.commit === true || typeof definition.commit === "string") {
    const message = typeof definition.commit === "string" ? definition.commit.trim() : ""
    return {
      message: message || `chore: update ${definition.name} workspace`,
      paths: diff.entries.map(entry => normalizeWorkspacePath(entry.path)),
    }
  }

  const policy = normalizePolicy(definition)
  const paths = diff.entries.map(entry => normalizeWorkspacePath(entry.path))
  const rules = paths.map(path => matchRule(policy, path)?.rule)
  if (!rules.length || rules.some(rule => !rule?.commit)) return

  const message = rules
    .map(rule => rule?.commit)
    .find((commit): commit is string => typeof commit === "string" && commit.trim().length > 0)
    ?.trim()

  return {
    message: message || `chore: update ${definition.name} workspace`,
    paths,
  }
}
