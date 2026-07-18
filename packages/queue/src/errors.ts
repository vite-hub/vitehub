import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorDetails, ViteHubErrorOptions } from "@vite-hub/runtime"
import type { QueueProvider } from "./types.ts"

export type QueueProviderOperation = "create-client" | "load-sdk" | "send" | "send-batch"

export type QueueErrorCode =
  | "CLOUDFLARE_BINDING_INVALID"
  | "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED"
  | "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS"
  | "QUEUE_DEFINITION_LOAD_FAILED"
  | "QUEUE_DEFINITION_NOT_FOUND"
  | "QUEUE_DISABLED"
  | "QUEUE_PROVIDER_OPERATION_FAILED"
  | "VERCEL_PROVIDER_EXPECTED"
  | "VERCEL_QUEUE_REGION_REQUIRED"
  | "VERCEL_QUEUE_SDK_INVALID"
  | "VERCEL_QUEUE_SDK_LOAD_FAILED"
  | "VERCEL_TOPIC_RESOLUTION_REQUIRED"
  | "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS"

type QueueErrorDetailMap = {
  CLOUDFLARE_BINDING_INVALID: { readonly provider: "cloudflare" }
  CLOUDFLARE_BINDING_RESOLUTION_REQUIRED: { readonly provider: "cloudflare" }
  CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS: { readonly provider: "cloudflare", readonly unsupported: readonly ("idempotencyKey" | "retentionSeconds")[] }
  QUEUE_DEFINITION_LOAD_FAILED: { readonly queue?: string }
  QUEUE_DEFINITION_NOT_FOUND: { readonly queue?: string }
  QUEUE_DISABLED: never
  QUEUE_PROVIDER_OPERATION_FAILED: { readonly operation: Exclude<QueueProviderOperation, "load-sdk">, readonly provider: QueueProvider }
  VERCEL_PROVIDER_EXPECTED: { readonly provider: QueueProvider }
  VERCEL_QUEUE_REGION_REQUIRED: { readonly provider: "vercel" }
  VERCEL_QUEUE_SDK_INVALID: { readonly provider: "vercel" }
  VERCEL_QUEUE_SDK_LOAD_FAILED: { readonly operation: "load-sdk", readonly provider: "vercel" }
  VERCEL_TOPIC_RESOLUTION_REQUIRED: { readonly provider: "vercel" }
  VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS: { readonly provider: "vercel", readonly unsupported: readonly "contentType"[] }
}

export type QueueErrorDetails<TCode extends string = QueueErrorCode> = TCode extends QueueErrorCode
  ? QueueErrorDetailMap[TCode] extends never ? ViteHubErrorDetails : QueueErrorDetailMap[TCode]
  : ViteHubErrorDetails

type QueueErrorDetailOptions<TCode extends string> = TCode extends QueueErrorCode
  ? QueueErrorDetailMap[TCode] extends never
    ? { readonly details?: never }
    : { readonly details?: QueueErrorDetailMap[TCode] }
  : { readonly details?: ViteHubErrorDetails }

export type QueueErrorMetadata = ViteHubErrorOptions & {
  readonly code?: string
  readonly httpStatus?: number
}

export type QueueErrorOptions<TCode extends string = QueueErrorCode> = TCode extends string
  ? Omit<ViteHubErrorOptions, "details"> & QueueErrorDetailOptions<TCode> & {
    readonly code: NoInfer<TCode>
    readonly httpStatus?: number
    readonly message: string
  }
  : never

export class QueueError<TCode extends string = QueueErrorCode> extends ViteHubError<TCode, QueueErrorDetails<TCode>> {
  readonly httpStatus?: number

  constructor(options: QueueErrorOptions<NoInfer<TCode>>)
  constructor(message: string, metadata?: QueueErrorMetadata)
  constructor(messageOrOptions: string | QueueErrorOptions<NoInfer<TCode>>, metadata: QueueErrorMetadata = {}) {
    const options = typeof messageOrOptions === "string" ? metadata : messageOrOptions
    const message = typeof messageOrOptions === "string" ? messageOrOptions : messageOrOptions.message
    super((options.code || "QUEUE_ERROR") as TCode, message, options as ViteHubErrorOptions<QueueErrorDetails<TCode>>)
    this.name = "QueueError"
    this.httpStatus = options.httpStatus
  }
}

export function normalizePublicQueueIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 128 || value.trim() !== value) return
  if (!/^[a-z\d][a-z\d._/-]*$/i.test(value)) return
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^[a-z]:\//i.test(value)) return
  if (value.split("/").some(part => part === "." || part === "..")) return
  return value
}

export function isQueueBoundaryIdentity(error: unknown): boolean {
  return error instanceof QueueError || (error instanceof Error && error.name === "AbortError")
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
    throw new QueueError<"QUEUE_PROVIDER_OPERATION_FAILED">({
      cause,
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation, provider },
      message: `[vitehub] ${provider} queue provider failed during ${operation}.`,
    })
  }
}
