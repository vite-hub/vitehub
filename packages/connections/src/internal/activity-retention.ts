import { connectionsErrorDiagnostics } from "../error-diagnostics.ts"

import type { ConnectionActivityRetention } from "../types.ts"

/** Keep activity for 14 days and at most 10,000 events. */
export const defaultActivityRetention: Required<ConnectionActivityRetention> = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxRecords: 10_000,
}

/** Apply the defaults and check the limits. `false` keeps all activity. */
export function resolveActivityRetention(value: ConnectionActivityRetention | false | undefined): Required<ConnectionActivityRetention> | false {
  if (value === false) return false
  const retention = {
    maxAgeMs: value?.maxAgeMs ?? defaultActivityRetention.maxAgeMs,
    maxRecords: value?.maxRecords ?? defaultActivityRetention.maxRecords,
  }
  for (const [name, limit] of Object.entries(retention)) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw connectionsErrorDiagnostics.CONNECTIONS_INVALID_CONFIG({ problem: "type" })
    }
  }
  return retention
}
