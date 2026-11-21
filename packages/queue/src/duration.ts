import { parseDuration, toResultError } from "@vite-hub/runtime"
import { runtimeErrorDiagnostics } from "@vite-hub/runtime/internal/error-diagnostics"

import type { Duration, Result } from "@vite-hub/runtime"

/** `delay` and `retention` in seconds, as the providers take them. */
export interface QueueTimes {
  delaySeconds?: number
  retentionSeconds?: number
}

/**
 * Reads `delay` and `retention` of a send. `delay` is a duration such as `"1m"`. `retention` is a duration or a number
 * of seconds. A value that is not a duration returns `RUNTIME_DURATION_INVALID`. Pass `"ceil"` for a provider that
 * takes whole seconds, so a job never runs earlier than the caller asked.
 */
export function readQueueTimes(options: { delay?: Duration, retention?: Duration | number }, round?: "ceil"): Result<QueueTimes, "RUNTIME_DURATION_INVALID"> {
  const seconds = (milliseconds: number) => round === "ceil" ? Math.ceil(milliseconds / 1000) : milliseconds / 1000
  try {
    const delaySeconds = options.delay === undefined ? undefined : seconds(parseDuration(options.delay, "delay", undefined, "s"))
    const retentionSeconds = typeof options.retention === "number"
      ? round === "ceil" ? Math.ceil(options.retention) : options.retention
      : options.retention === undefined ? undefined : seconds(parseDuration(options.retention, "retention"))
    return [undefined, {
      ...(delaySeconds === undefined ? {} : { delaySeconds }),
      ...(retentionSeconds === undefined ? {} : { retentionSeconds }),
    }]
  }
  catch (error) {
    if (runtimeErrorDiagnostics.RUNTIME_DURATION_INVALID.is(error)) return [toResultError(error), undefined]
    throw error
  }
}
