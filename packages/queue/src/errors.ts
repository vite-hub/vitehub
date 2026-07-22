import { getViteHubErrorShape, ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorDetails, ViteHubErrorOptions, ViteHubErrorShape } from "@vite-hub/runtime"
import type { QueueProvider } from "./types.ts"

export type QueueProviderOperation = "create-client" | "load-sdk" | "send" | "send-batch"

export const cloudflareUnsupportedEnqueueOptions = ["idempotencyKey", "region", "retentionSeconds"] as const

export type QueueErrorCode =
  | "CLOUDFLARE_BINDING_INVALID"
  | "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED"
  | "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS"
  | "QUEUE_DEFINITION_LOAD_FAILED"
  | "QUEUE_DEFINITION_NOT_FOUND"
  | "QUEUE_DISABLED"
  | "QUEUE_PROVIDER_OPERATION_FAILED"
  | "QUEUE_PROVIDER_RESPONSE_INVALID"
  | "VERCEL_PROVIDER_EXPECTED"
  | "VERCEL_QUEUE_REGION_REQUIRED"
  | "VERCEL_QUEUE_SDK_INVALID"
  | "VERCEL_QUEUE_SDK_LOAD_FAILED"
  | "VERCEL_TOPIC_RESOLUTION_REQUIRED"
  | "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS"

type QueueErrorDetailMap = {
  CLOUDFLARE_BINDING_INVALID: { readonly provider: "cloudflare" }
  CLOUDFLARE_BINDING_RESOLUTION_REQUIRED: { readonly provider: "cloudflare" }
  CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS: { readonly provider: "cloudflare", readonly unsupported: readonly (typeof cloudflareUnsupportedEnqueueOptions)[number][] }
  QUEUE_DEFINITION_LOAD_FAILED: { readonly queue?: string }
  QUEUE_DEFINITION_NOT_FOUND: { readonly queue?: string }
  QUEUE_DISABLED: ViteHubErrorDetails
  QUEUE_PROVIDER_OPERATION_FAILED: { readonly operation: Exclude<QueueProviderOperation, "load-sdk">, readonly provider: QueueProvider }
  QUEUE_PROVIDER_RESPONSE_INVALID: { readonly operation: "send", readonly provider: "vercel" }
  VERCEL_PROVIDER_EXPECTED: { readonly provider: QueueProvider }
  VERCEL_QUEUE_REGION_REQUIRED: { readonly provider: "vercel" }
  VERCEL_QUEUE_SDK_INVALID: { readonly provider: "vercel" }
  VERCEL_QUEUE_SDK_LOAD_FAILED: { readonly operation: "load-sdk", readonly provider: "vercel" }
  VERCEL_TOPIC_RESOLUTION_REQUIRED: { readonly provider: "vercel" }
  VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS: { readonly provider: "vercel", readonly unsupported: readonly "contentType"[] }
}

export type QueueErrorDetails<TCode extends QueueErrorCode = QueueErrorCode> = QueueErrorDetailMap[TCode]

type QueueErrorOptions<TCode extends QueueErrorCode> = Omit<ViteHubErrorOptions<QueueErrorDetails<TCode>>, "details"> & {
  details?: QueueErrorDetails<TCode>
}

const queueErrorMessages: Record<QueueErrorCode, string> = {
  CLOUDFLARE_BINDING_INVALID: "[vitehub] Cloudflare queue binding is invalid.",
  CLOUDFLARE_BINDING_RESOLUTION_REQUIRED: "[vitehub] Cloudflare queue requires a concrete request-scoped binding.",
  CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS: "[vitehub] Cloudflare queue does not support one or more enqueue options.",
  QUEUE_DEFINITION_LOAD_FAILED: "[vitehub] Queue Definition could not be loaded.",
  QUEUE_DEFINITION_NOT_FOUND: "[vitehub] Queue Definition is not registered. Queue Runtime Registry is installed by generated Provider Output.",
  QUEUE_DISABLED: "[vitehub] Queue runtime is disabled.",
  QUEUE_PROVIDER_OPERATION_FAILED: "[vitehub] Queue provider operation failed.",
  QUEUE_PROVIDER_RESPONSE_INVALID: "[vitehub] Vercel queue provider returned an invalid send response.",
  VERCEL_PROVIDER_EXPECTED: "[vitehub] Hosted Vercel Queue Delivery requires the Vercel provider.",
  VERCEL_QUEUE_REGION_REQUIRED: "[vitehub] Vercel queue region could not be resolved.",
  VERCEL_QUEUE_SDK_INVALID: "[vitehub] Vercel queue SDK does not expose the expected client API.",
  VERCEL_QUEUE_SDK_LOAD_FAILED: "[vitehub] Vercel queue SDK could not be loaded.",
  VERCEL_TOPIC_RESOLUTION_REQUIRED: "[vitehub] Vercel queue requires a concrete topic.",
  VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS: "[vitehub] Vercel queue does not support one or more enqueue options.",
}

const queueOwnedErrors = new WeakSet<object>()

export function createQueueError<TCode extends QueueErrorCode>(
  code: TCode,
  options: QueueErrorOptions<TCode> = {},
): ViteHubError<TCode, QueueErrorDetails<TCode>> {
  const details = options.details
  const message = code === "QUEUE_PROVIDER_OPERATION_FAILED" && details && "provider" in details && "operation" in details
    ? `[vitehub] ${details.provider} queue provider failed during ${details.operation}.`
    : queueErrorMessages[code]
  const error = new ViteHubError(code, message, options)
  queueOwnedErrors.add(error)
  return error
}

export function isQueueOwnedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && queueOwnedErrors.has(error)
}

export function getQueueErrorPublicShape(error: unknown): ViteHubErrorShape | undefined {
  return getViteHubErrorShape(error)
}

export function normalizePublicQueueIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 128 || value.trim() !== value) return
  if (!/^[a-z\d][a-z\d._/-]*$/i.test(value)) return
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^[a-z]:\//i.test(value)) return
  if (value.split("/").some(part => part === "." || part === "..")) return
  return value
}

export function isQueueBoundaryIdentity(error: unknown): boolean {
  if (getViteHubErrorShape(error)) return true
  try {
    return error instanceof Error && error.name === "AbortError"
  }
  catch {
    return false
  }
}

export async function runQueueProviderOperation<TResult>(
  provider: QueueProvider,
  operation: Exclude<QueueProviderOperation, "load-sdk">,
  run: () => Promise<TResult> | TResult,
): Promise<TResult> {
  try {
    return await run()
  }
  catch (cause) {
    if (isQueueBoundaryIdentity(cause)) throw cause
    throw createQueueError("QUEUE_PROVIDER_OPERATION_FAILED", {
      cause,
      details: { operation, provider },
    })
  }
}
