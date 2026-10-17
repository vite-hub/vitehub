import type { BaseOptions, ForgeProvider, MergeMethod, RepoRef } from "forges"

import { forgeDiagnostics } from "../error-diagnostics.ts"
import { forgeErrorStatus } from "../provider.ts"
import { isRecord, nextPage, repositoryPath, requireGitHub } from "./github.ts"

// Gap: forges has no branch protection, rulesets or required checks.

/** A status check that a branch requires. `appId` is null when any source may report it. */
export interface BranchRequiredCheck {
  context: string
  appId: number | null
}

/** The merge requirements of one branch, from active rulesets and classic branch protection. */
export interface BranchRules {
  /** Required status checks, without duplicates. */
  requiredChecks: BranchRequiredCheck[]
  /** An active ruleset requires workflows, which cannot be reduced to check contexts. */
  requiredWorkflows: boolean
  /** Merge methods that every active pull request rule allows. Undefined when no rule limits them. */
  mergeMethods?: MergeMethod[]
  /** Where the classic protection came from. The branch summary needs only Contents read access. */
  classicSource: "protection-endpoint" | "branch-summary" | "unprotected-branch"
}

const mergeMethods: Record<string, MergeMethod> = { merge: "merge", squash: "squash", rebase: "rebase" }

function invalid(message: string, cause?: unknown): Error {
  return forgeDiagnostics.FORGE_R0007({ message, cause })
}

function appId(value: unknown): number | null {
  if (value === undefined || value === null || value === -1) return null
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid("Invalid required-check integration ID.")
  return value
}

function requiredCheck(value: unknown, source: "rule" | "classic"): BranchRequiredCheck {
  if (!isRecord(value) || typeof value.context !== "string" || !value.context.trim()) throw invalid("Incomplete required-check context.")
  return { context: value.context, appId: appId(source === "rule" ? value.integration_id : value.app_id) }
}

function classicChecks(value: unknown): BranchRequiredCheck[] {
  if (!isRecord(value) || !Array.isArray(value.contexts) || (value.checks !== undefined && !Array.isArray(value.checks))) {
    throw invalid("Incomplete classic status-check protection.")
  }
  const bound = (Array.isArray(value.checks) ? value.checks : []).map(item => requiredCheck(item, "classic"))
  for (const context of value.contexts) {
    if (typeof context !== "string" || !context.trim()) throw invalid("Incomplete classic required-check context.")
    // contexts repeats the check names but loses their App binding.
    if (!bound.some(item => item.context === context)) bound.push({ context, appId: null })
  }
  return bound
}

async function read(provider: ForgeProvider, path: string, options?: BaseOptions): Promise<{ status: number, data?: unknown, link: string | null }> {
  try {
    const response = await provider.request<unknown>("GET", path, { signal: options?.signal })
    return { status: response.status, data: response.data, link: response.headers.get("link") }
  }
  catch (error) {
    options?.signal?.throwIfAborted()
    const status = forgeErrorStatus(error)
    if (status === undefined) throw error
    return { status, link: null }
  }
}

async function activeRules(provider: ForgeProvider, path: string, options?: BaseOptions): Promise<unknown[]> {
  const rules: unknown[] = []
  const visited = new Set<string>()
  let next: string | undefined = `${path}?per_page=100`
  for (let page = 0; next && page < 1000; page++) {
    if (visited.has(next)) throw invalid("GitHub repeated a branch rules page.")
    visited.add(next)
    const response = await read(provider, next, options)
    if (response.status !== 200 || !Array.isArray(response.data)) throw invalid(`Active branch rules unavailable (HTTP ${response.status}).`)
    rules.push(...response.data)
    try {
      next = nextPage(provider, response.link)
    }
    catch (error) {
      throw invalid("GitHub returned a branch rules page outside the API base.", error)
    }
  }
  if (next) throw invalid("Branch rules have too many pages.")
  return rules
}

/**
 * Read the active rulesets and classic protection of a GitHub branch. Throws `FORGE_R0007` when GitHub
 * does not return a complete answer, so a caller never mistakes unknown rules for no rules.
 */
export async function branchRules(provider: ForgeProvider, repo: RepoRef, branch: string, options?: BaseOptions): Promise<BranchRules> {
  requireGitHub(provider, "branchRules()")
  const prefix = repositoryPath(repo)
  const encodedBranch = encodeURIComponent(branch)
  const [rules, classic] = await Promise.all([
    activeRules(provider, `${prefix}/rules/branches/${encodedBranch}`, options),
    read(provider, `${prefix}/branches/${encodedBranch}/protection/required_status_checks`, options),
  ])
  const requiredChecks: BranchRequiredCheck[] = []
  let requiredWorkflows = false
  let allowed: Set<MergeMethod> | undefined
  for (const value of rules) {
    if (!isRecord(value) || typeof value.type !== "string") throw invalid("Incomplete active branch rule.")
    if (value.type === "required_workflows") {
      requiredWorkflows = true
      continue
    }
    if (value.type === "workflows") {
      const workflows = isRecord(value.parameters) ? value.parameters.workflows : undefined
      if (!Array.isArray(workflows)) throw invalid("Incomplete ruleset workflow parameters.")
      requiredWorkflows ||= workflows.length > 0
      continue
    }
    if (value.type === "required_status_checks") {
      const parameters = isRecord(value.parameters) ? value.parameters.required_status_checks : undefined
      if (!Array.isArray(parameters)) throw invalid("Incomplete ruleset required-check parameters.")
      requiredChecks.push(...parameters.map(item => requiredCheck(item, "rule")))
      continue
    }
    if (value.type !== "pull_request") continue
    const methods = isRecord(value.parameters) ? value.parameters.allowed_merge_methods : undefined
    if (methods === undefined) continue
    if (!Array.isArray(methods)) throw invalid("Incomplete pull request rule merge methods.")
    const rule = new Set(methods.flatMap(method => typeof method === "string" && mergeMethods[method] ? [mergeMethods[method]] : []))
    allowed = allowed ? new Set([...allowed].filter(method => rule.has(method))) : rule
  }
  let classicSource: BranchRules["classicSource"] = "protection-endpoint"
  if (classic.status === 200) requiredChecks.push(...classicChecks(classic.data))
  else if (classic.status === 403 || classic.status === 404) {
    // Get-a-branch documents the complete required-check summary and needs only Contents read access.
    const summary = await read(provider, `${prefix}/branches/${encodedBranch}`, options)
    if (summary.status !== 200 || !isRecord(summary.data)) throw invalid("Branch protection summary unavailable.")
    if (summary.data.protected === false) classicSource = "unprotected-branch"
    else {
      const protection = isRecord(summary.data.protection) ? summary.data.protection : undefined
      if (summary.data.protected !== true || protection?.enabled !== true) throw invalid("Branch protection summary is incomplete.")
      classicSource = "branch-summary"
      // Other classic protection rules do not imply required status checks.
      if ("required_status_checks" in protection) {
        const checks = isRecord(protection.required_status_checks) ? protection.required_status_checks : undefined
        if (!checks || !Array.isArray(checks.contexts) || !Array.isArray(checks.checks)
          || !["everyone", "non_admins", "off"].includes(String(checks.enforcement_level))) {
          throw invalid("Classic protection response is ambiguous; branch summary is incomplete.")
        }
        if (checks.enforcement_level === "off" && (checks.contexts.length || checks.checks.length)) {
          throw invalid("Disabled status-check summary contains ambiguous requirements.")
        }
        const bound = checks.checks
        if (checks.contexts.some(context => !bound.some(item => isRecord(item) && item.context === context))) {
          throw invalid("Branch summary omits required-check integration bindings.")
        }
        requiredChecks.push(...classicChecks(checks))
      }
    }
  }
  else throw invalid(`Classic protection unavailable (HTTP ${classic.status}).`)
  return {
    requiredChecks: [...new Map(requiredChecks.map(item => [`${item.context}\0${item.appId ?? "*"}`, item])).values()],
    requiredWorkflows,
    ...(allowed ? { mergeMethods: [...allowed] } : {}),
    classicSource,
  }
}
