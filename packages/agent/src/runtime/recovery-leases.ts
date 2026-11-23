import { useLeases } from "@vite-hub/database"

import type { LeaseStore } from "@vite-hub/runtime"

/**
 * The Leases of the Agent recovery sweep, in the default or only Database. Without one, the sweep does not run and
 * only a server start fails the Invocations of a stopped server.
 */
export function agentRecoveryLeases(): { leases: LeaseStore } | undefined {
  try {
    return { leases: useLeases() }
  }
  catch {
    console.warn("[vitehub:agent] The Agent recovery sweep needs the default or only Database, and the app has several without a `default`. Invocations of a stopped server are failed only when a server starts.")
    return undefined
  }
}
