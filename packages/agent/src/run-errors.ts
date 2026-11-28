import { defineErrors } from "@vite-hub/runtime"

import type { ResultError } from "@vite-hub/runtime"

/** Codes that `runAgent()` and `streamAgent()` return in the `[error, data]` tuple. */
export type AgentErrorCode = "AGENT_MODEL_GATEWAY_UNAUTHENTICATED" | "AGENT_RUN_CANCELLED" | "AGENT_RUN_FAILED"

// Keep published codes stable. Each code has its own diagnostic page.
const agentRunErrors = /*#__PURE__*/ defineErrors({
  docs: "https://vitehub.dev/docs/agents/diagnostics",
  codes: {
    AGENT_MODEL_GATEWAY_UNAUTHENTICATED: {
      why: "The Vercel AI Gateway rejected the model request: no AI Gateway key or Vercel OIDC token is set, or the one that is set is not valid.",
      fix: "Set `AI_GATEWAY_API_KEY`, or add `agent.models.emulate` rules for dev. See https://vitehub.dev/docs/agents/no-ai-key.",
    },
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

const gatewayAuthenticationMarker = Symbol.for("vercel.ai.gateway.error.GatewayAuthenticationError")

/**
 * Finds the AI Gateway authentication error in a failure, through `cause` and the last error of an AI SDK retry.
 * A thrown value can be a revoked proxy or have throwing getters, so a failed read means no match.
 */
export function findGatewayAuthenticationError(failure: unknown): object | undefined {
  try {
    let error = failure
    for (let depth = 0; depth < 8 && typeof error === "object" && error !== null; depth++) {
      if (gatewayAuthenticationMarker in error) return error
      error = Reflect.get(error, "name") === "AI_RetryError" ? Reflect.get(error, "lastError") : Reflect.get(error, "cause")
    }
  }
  catch {
    return undefined
  }
}

/** Returns the `runAgent()` error for a failure. A failure after the input's `abortSignal` aborted is a cancellation. */
export function agentRunError(cause: unknown, cancelled: boolean): ResultError<AgentErrorCode> {
  if (cancelled) return agentRunErrors.AGENT_RUN_CANCELLED({ cause })
  return findGatewayAuthenticationError(cause)
    ? agentRunErrors.AGENT_MODEL_GATEWAY_UNAUTHENTICATED({ cause })
    : agentRunErrors.AGENT_RUN_FAILED({ cause })
}
