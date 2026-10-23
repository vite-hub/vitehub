import type { BranchRules, MergeMethod } from "forges"

import { forgeDiagnostics } from "../error-diagnostics.ts"
import { isRecord } from "./github.ts"

// Gap: forges `BranchRules` has no required workflows, ruleset merge methods or classic protection source.

/** What GitHub branch rules ask for beyond `BranchRules` from `provider.repos.branchRules()`. */
export interface GitHubBranchRuleDetails {
  /** An active ruleset requires workflows, which cannot be reduced to check names. */
  requiredWorkflows: boolean
  /** Merge methods that every active pull request rule allows. Undefined when no rule limits them. */
  mergeMethods?: MergeMethod[]
  /**
   * Where the classic protection came from. `branch-summary` means the credential cannot read the protection
   * endpoint (no admin access): the required checks are complete, the required approvals are not.
   */
  classicSource: "protection-endpoint" | "branch-summary" | "unprotected-branch"
}

const mergeMethods: Record<string, MergeMethod> = { merge: "merge", squash: "squash", rebase: "rebase" }

function invalid(message: string): Error {
  return forgeDiagnostics.FORGE_R0007({ message })
}

/**
 * Read the GitHub-only details from the `raw` answer of `provider.repos.branchRules()`. Throws `FORGE_R0007`
 * when the answer is not complete GitHub branch rules, so a caller never mistakes unknown rules for no rules.
 */
export function githubBranchRuleDetails(rules: BranchRules): GitHubBranchRuleDetails {
  const raw = rules.raw
  if (!isRecord(raw) || !isRecord(raw.branch) || !Array.isArray(raw.rules)) throw invalid("Branch rules are not complete GitHub branch rules.")
  let requiredWorkflows = false
  let allowed: Set<MergeMethod> | undefined
  for (const value of raw.rules) {
    if (!isRecord(value) || typeof value.type !== "string") throw invalid("Incomplete active branch rule.")
    const parameters = isRecord(value.parameters) ? value.parameters : undefined
    if (value.type === "required_workflows") requiredWorkflows = true
    else if (value.type === "workflows") {
      if (!Array.isArray(parameters?.workflows)) throw invalid("Incomplete ruleset workflow parameters.")
      requiredWorkflows ||= parameters.workflows.length > 0
    }
    else if (value.type === "required_status_checks") {
      if (!Array.isArray(parameters?.required_status_checks)) throw invalid("Incomplete ruleset required-check parameters.")
    }
    else if (value.type === "pull_request" && parameters?.allowed_merge_methods !== undefined) {
      if (!Array.isArray(parameters.allowed_merge_methods)) throw invalid("Incomplete pull request rule merge methods.")
      const rule = new Set(parameters.allowed_merge_methods.flatMap(method => typeof method === "string" && mergeMethods[method] ? [mergeMethods[method]] : []))
      allowed = allowed ? new Set([...allowed].filter(method => rule.has(method))) : rule
    }
  }
  const protection = isRecord(raw.branch.protection) ? raw.branch.protection : undefined
  let classicSource: GitHubBranchRuleDetails["classicSource"] = "unprotected-branch"
  if (protection?.enabled === true) {
    const checks = protection.required_status_checks
    if (checks !== undefined) {
      if (!isRecord(checks) || !Array.isArray(checks.contexts) || !Array.isArray(checks.checks)) {
        throw invalid("Classic protection response is ambiguous; branch summary is incomplete.")
      }
      // `contexts` repeats the check names without their App binding. forges falls back to it when `checks` is empty.
      const bound = checks.checks
      if (checks.enforcement_level !== "off" && checks.contexts.some(context => !bound.some(item => isRecord(item) && item.context === context))) {
        throw invalid("Branch summary omits required-check integration bindings.")
      }
    }
    // forges reads classic required checks from the branch summary, which needs only Contents read access.
    // The protection endpoint needs admin access; without it, forges warns with `insufficient_scope`.
    classicSource = rules.warnings?.some(warning => warning.code === "insufficient_scope") ? "branch-summary" : "protection-endpoint"
  }
  else if (raw.branch.protected === true) throw invalid("Branch protection summary is incomplete.")
  return { requiredWorkflows, ...(allowed ? { mergeMethods: [...allowed] } : {}), classicSource }
}
