import { redactInspectionText } from "@vite-hub/internal/inspect"

import { peekRateLimit, resetRateLimit } from "../counters.ts"
import { rateLimitErrorDiagnostics } from "../error-diagnostics.ts"

import type { RateLimitPeekInspection, RateLimitResetInspection } from "../counters.ts"

/** Removes credentials from the echoed key and from driver error text before the result leaves the runtime. */
function redact<T extends RateLimitPeekInspection | RateLimitResetInspection>(result: T): T {
  return {
    ...result,
    key: redactInspectionText(result.key),
    ...("reason" in result ? { reason: redactInspectionText(result.reason) } : {}),
  }
}

async function guarded<T extends RateLimitPeekInspection | RateLimitResetInspection>(run: () => Promise<T>): Promise<T> {
  try {
    return redact(await run())
  }
  catch (error) {
    const failure = rateLimitErrorDiagnostics.RATE_LIMIT_OPERATION_FAILED({ cause: error })
    // The CLI and the Console show `statusMessage`: the driver error, without credentials.
    throw Object.assign(failure, { status: 500, statusMessage: redactInspectionText(error instanceof Error ? error.message : failure.message) })
  }
}

/** Reads the counter of one key without consuming a token. */
export async function peekRateLimitOperation(name: string, key: string): Promise<RateLimitPeekInspection> {
  return await guarded(() => peekRateLimit(name, key))
}

/** Deletes the counter of one key, where the provider supports it. */
export async function resetRateLimitOperation(name: string, key: string): Promise<RateLimitResetInspection> {
  return await guarded(() => resetRateLimit(name, key))
}
