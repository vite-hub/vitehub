import { agentDiagnostics } from "../agent-diagnostics.ts"
import { normalizeRetention } from "../internal/retention-policy.ts"

import type { NormalizedRetention } from "../internal/retention-policy.ts"
import type { AgentRetentionPolicy } from "../retention.ts"

/**
 * The retention limits of a D1 Agent Invocation store: 30 days and 10,000 records by default, no size limit. It throws
 * `AGENT_R0911` for an invalid limit. It is apart from the store code, so a journal can check its limits when the server
 * starts and load the store on first use.
 */
export function d1AgentInvocationRetention(options: AgentRetentionPolicy): NormalizedRetention {
  return normalizeRetention({ maxAge: options.maxAge, maxRecords: options.maxRecords, maxSize: options.maxSize }, {
    label: "D1 Agent Invocation",
    defaults: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxRecords: 10_000, maxSize: false },
    size: "none",
    error: message => agentDiagnostics.AGENT_R0911({ message: `[vitehub] ${message}` }),
  })
}
