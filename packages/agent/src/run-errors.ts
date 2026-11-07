import { defineErrors } from "@vite-hub/runtime"

import type { ResultError } from "@vite-hub/runtime"

/** Codes that `runAgent()` and `streamAgent()` return in the `[error, data]` tuple. */
export type AgentErrorCode = "AGENT_RUN_CANCELLED" | "AGENT_RUN_FAILED"

// Keep published codes stable. Each code has a heading on the docs page.
const agentRunErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/agents/invocations",
  codes: {
    AGENT_RUN_CANCELLED: {
      why: "The Invocation stopped because its `abortSignal` aborted.",
      fix: "Read `error.cause` for the abort reason. Start a new Invocation if the work is still needed.",
    },
    AGENT_RUN_FAILED: {
      why: "The Invocation failed.",
      fix: "Read `error.cause` for the error from the Driver, a hook, a Capability, input validation, or background work.",
    },
  },
})

/** Returns the `runAgent()` error for a failure. A failure after the input's `abortSignal` aborted is a cancellation. */
export function agentRunError(cause: unknown, cancelled: boolean): ResultError<AgentErrorCode> {
  return cancelled
    ? agentRunErrors.AGENT_RUN_CANCELLED({ cause })
    : agentRunErrors.AGENT_RUN_FAILED({ cause })
}
