import { minimatch } from "minimatch"

import { workspaceError } from "./errors.ts"
import { contentToBytes, normalizeWorkspacePath } from "./path.ts"

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

export interface WorkspaceWritePolicy {
  after(input: WorkspaceWriteInput): Promise<void>
  before(input: Omit<WorkspaceWriteInput, "rule">): Promise<WorkspaceWriteInput>
  error(input: WorkspaceWriteInput, error: unknown): Promise<void>
}

interface NormalizedWorkspacePolicy {
  hooks: WorkspaceHooks
  rules: Array<ResolvedWorkspaceRule & { specificity: number }>
}

function normalizeMaxBytes(value: WorkspaceRule["maxBytes"]): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === "number") return value
  const match = /^(\d+)(kb|mb)$/.exec(value.toLowerCase())
  if (!match) throw new TypeError(`[vitehub] Invalid workspace rule maxBytes value "${value}".`)
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

function normalizeRules(rules: WorkspaceRules = {}): NormalizedWorkspacePolicy["rules"] {
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

  for (const plugin of definition.plugins || []) {
    if (!plugin?.id) throw new TypeError("[vitehub] Workspace plugins require an id.")
    rules = { ...rules, ...plugin.rules }
    hooks = mergeHooks(hooks, plugin.hooks)
  }

  rules = { ...rules, ...definition.rules }
  hooks = mergeHooks(hooks, definition.hooks)

  return {
    hooks,
    rules: normalizeRules(rules),
  }
}

function matchRule(policy: NormalizedWorkspacePolicy, path: string): ResolvedWorkspaceRule | undefined {
  const normalized = normalizeWorkspacePath(path)
  let matched: ResolvedWorkspaceRule | undefined
  for (const rule of policy.rules) {
    const globstarDirectory = rule.pattern.endsWith("/**") ? rule.pattern.slice(0, -3) : undefined
    if (minimatch(normalized, rule.pattern, { dot: true }) || normalized === globstarDirectory) matched = rule
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

function assertRuleAllows(input: WorkspaceWriteInput) {
  const rule = input.rule
  if (!rule) return

  const exists = Boolean(input.previous)
  if (!writeAllowed(rule.write, input.operation, exists)) {
    throw workspaceError(`[vitehub] Workspace rule "${rule.pattern}" does not allow ${input.operation} for ${input.path}.`)
  }

  if (rule.maxBytes !== undefined && sizeOf(input.content) > rule.maxBytes) {
    throw workspaceError(`[vitehub] Workspace rule "${rule.pattern}" limits writes to ${rule.maxBytes} bytes: ${input.path}.`)
  }

  if (rule.mediaType && input.mediaType) {
    const allowed = Array.isArray(rule.mediaType) ? rule.mediaType : [rule.mediaType]
    if (!allowed.includes(input.mediaType)) {
      throw workspaceError(`[vitehub] Workspace rule "${rule.pattern}" does not allow media type ${input.mediaType}: ${input.path}.`)
    }
  }
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
  const policy = normalizePolicy(definition)

  return {
    async before(input) {
      let current: WorkspaceWriteInput = {
        ...input,
        rule: matchRule(policy, input.path),
      }
      await runHooks(policy.hooks, "write:before", current)
      assertRuleAllows(current)
      if (current.rule?.validate.length) current = await runValidators(current.rule.validate, current)
      await runHooks(policy.hooks, "write:validate", current)
      return current
    },
    async after(input) {
      await runHooks(policy.hooks, "write:after", input)
    },
    async error(input, error) {
      for (const hook of toArray(policy.hooks["write:error"])) await hook({ ...input, error })
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
  const rules = paths.map(path => matchRule(policy, path))
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
