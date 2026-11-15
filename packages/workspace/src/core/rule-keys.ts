import type { WorkspaceRules } from "./types.ts"
import { workspaceErrorDiagnostics } from "../error-diagnostics.ts"

/** The rule fields that a more specific rule replaces only when it sets them. */
export const cascadingRuleKeys = ["commit", "maxBytes", "mediaType", "write"] as const

const workspaceRuleKeys = new Set<string>([...cascadingRuleKeys, "validate"])

/** Rejects rule keys that ViteHub does not enforce, such as `read`, so that a rule never looks like a protection it is not. */
export function assertWorkspaceRules(rules: WorkspaceRules | undefined): void {
  for (const [pattern, rule] of Object.entries(rules ?? {})) {
    for (const key of Object.keys(rule ?? {})) {
      if (key === "read") {
        throw workspaceErrorDiagnostics.WORKSPACE_R0075({ message: `[vitehub] Workspace rule "${pattern}" sets read. Workspace rules do not limit reads.` })
      }
      if (!workspaceRuleKeys.has(key)) {
        throw workspaceErrorDiagnostics.WORKSPACE_R0076({ message: `[vitehub] Workspace rule "${pattern}" does not support option "${key}".` })
      }
    }
  }
}
