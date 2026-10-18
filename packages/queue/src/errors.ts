import { Diagnostic } from "nostics"

import type { Result, ResultError } from "@vite-hub/runtime"

import type { QueueProvider } from "./types.ts"
import { queueErrorDiagnostics, type QueueProviderOperation } from "./error-diagnostics.ts"

export type { QueueProviderOperation }

export const cloudflareUnsupportedEnqueueOptions = ["idempotencyKey", "region", "retentionSeconds"] as const

type QueueCatalogCode = keyof typeof queueErrorDiagnostics

/** Returns `true` for an error from the Queue catalog. Pass `codes` to accept only some codes. */
export function isQueueError<TCode extends QueueCatalogCode = QueueCatalogCode>(error: unknown, codes?: readonly TCode[]): error is ResultError<TCode> {
  if (!(error instanceof Diagnostic) || !Object.hasOwn(queueErrorDiagnostics, error.code)) return false
  return !codes || codes.some(code => code === error.code)
}

/** Formats option names for an error `why`, for example `"region" and "retentionSeconds"`. */
export function formatQueueOptionNames(names: readonly string[]): string {
  const quoted = names.map(name => `\`${name}\``)
  return quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : quoted.join("")
}

export function normalizePublicQueueIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 128 || value.trim() !== value) return
  if (!/^[a-z\d][a-z\d._/-]*$/i.test(value)) return
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^[a-z]:\//i.test(value)) return
  if (value.split("/").some(part => part === "." || part === "..")) return
  return value
}

/**
 * Runs one provider call and returns `[error, data]`.
 * Any failure becomes `QUEUE_PROVIDER_FAILED` with the failure in `cause`.
 */
export async function queueProviderResult<TData>(
  provider: QueueProvider,
  operation: QueueProviderOperation,
  run: () => Promise<TData> | TData,
): Promise<Result<TData, "QUEUE_PROVIDER_FAILED">> {
  try {
    return [undefined, await run()]
  }
  catch (cause) {
    return [queueErrorDiagnostics.QUEUE_PROVIDER_FAILED({ cause, operation, provider }), undefined]
  }
}
