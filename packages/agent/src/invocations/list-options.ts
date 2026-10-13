import { agentDiagnostics } from "../agent-diagnostics.ts"
import { hasRuntimeType } from "../internal/runtime-type.ts"

import type { AgentInvocationListOptions } from "../invocations.ts"

const DEFAULT_LIST_LIMIT = 50
export const maxAgentInvocationListLimit = 100

// Entry points keep their public diagnostic identities while sharing validation rules.
const defaultListDiagnostics = {
  limit: agentDiagnostics.AGENT_R0618,
  searchType: agentDiagnostics.AGENT_R0619,
  searchLength: agentDiagnostics.AGENT_R0620,
  cursor: agentDiagnostics.AGENT_R0621,
}

function normalizeLimit(limit: number | undefined, diagnostics: typeof defaultListDiagnostics): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw diagnostics.limit({ message: "[vitehub] Agent Invocation list limit must be a positive integer." })
  }
  return Math.min(limit, maxAgentInvocationListLimit)
}

function normalizeSearch(search: string | undefined, diagnostics: typeof defaultListDiagnostics): string | undefined {
  if (search === undefined) return
  if (!hasRuntimeType(search, "string")) {
    throw diagnostics.searchType({ message: "[vitehub] Agent Invocation search must be a string." })
  }
  const value = search.trim()
  if (!value) return
  if (value.length > 256) {
    throw diagnostics.searchLength({ message: "[vitehub] Agent Invocation search must be at most 256 characters." })
  }
  return value
}

function normalizeBuiltInCursor(cursor: string | undefined, diagnostics: typeof defaultListDiagnostics): string | undefined {
  if (cursor === undefined) return
  const value = Number(cursor)
  if (!Number.isSafeInteger(value) || value < 1 || String(value) !== cursor) {
    throw diagnostics.cursor({ message: "[vitehub] Agent Invocation cursor is invalid." })
  }
  return cursor
}

/** Apply shared list rules while leaving custom store cursors opaque. */
export function normalizeAgentInvocationListOptions(
  options: AgentInvocationListOptions,
  { sequenceCursor = false, diagnostics = defaultListDiagnostics }: { sequenceCursor?: boolean, diagnostics?: typeof defaultListDiagnostics } = {},
): AgentInvocationListOptions & { limit: number } {
  const normalized = { ...options, limit: normalizeLimit(options.limit, diagnostics) }
  const search = normalizeSearch(options.search, diagnostics)
  if (search) normalized.search = search
  else delete normalized.search
  for (const key of ["agentName", "capabilityId", "triggeredBy"] as const) {
    const value = options[key]?.trim()
    if (value) normalized[key] = value
    else delete normalized[key]
  }
  if (sequenceCursor) normalizeBuiltInCursor(options.cursor, diagnostics)
  return normalized
}
