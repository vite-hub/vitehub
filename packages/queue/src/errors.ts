import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorDetail, ViteHubErrorDetails, ViteHubErrorOptions, ViteHubErrorShape } from "@vite-hub/runtime"
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
  CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS: { readonly provider: "cloudflare", readonly unsupported: readonly ("idempotencyKey" | "retentionSeconds")[] }
  QUEUE_DEFINITION_LOAD_FAILED: { readonly queue?: string }
  QUEUE_DEFINITION_NOT_FOUND: { readonly queue?: string }
  QUEUE_DISABLED: never
  QUEUE_PROVIDER_OPERATION_FAILED: { readonly operation: Exclude<QueueProviderOperation, "load-sdk">, readonly provider: QueueProvider }
  QUEUE_PROVIDER_RESPONSE_INVALID: { readonly operation: "send", readonly provider: "vercel" }
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

export type QueueErrorOptions<TCode extends string = QueueErrorCode> = TCode extends string
  ? TCode extends QueueErrorCode
    ? Omit<ViteHubErrorOptions, "details" | "retryable"> & QueueErrorDetailOptions<TCode> & {
      readonly code: NoInfer<TCode>
      readonly custom?: never
    }
    : Omit<ViteHubErrorOptions, "details"> & QueueErrorDetailOptions<TCode> & {
      readonly code: NoInfer<TCode>
      readonly custom: true
      readonly message: string
    }
  : never

type QueueErrorPublicShape = ViteHubErrorShape<string, ViteHubErrorDetails>

interface NormalizedQueueError {
  cause?: unknown
  code: string
  details?: ViteHubErrorDetails
  message: string
  requestId?: string
  retryable?: boolean
}

const queueErrorPublicShapes = new WeakMap<object, QueueErrorPublicShape>()

function parseBuiltInQueueErrorCode(value: unknown): QueueErrorCode | undefined {
  switch (value) {
    case "CLOUDFLARE_BINDING_INVALID":
    case "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED":
    case "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS":
    case "QUEUE_DEFINITION_LOAD_FAILED":
    case "QUEUE_DEFINITION_NOT_FOUND":
    case "QUEUE_DISABLED":
    case "QUEUE_PROVIDER_OPERATION_FAILED":
    case "QUEUE_PROVIDER_RESPONSE_INVALID":
    case "VERCEL_PROVIDER_EXPECTED":
    case "VERCEL_QUEUE_REGION_REQUIRED":
    case "VERCEL_QUEUE_SDK_INVALID":
    case "VERCEL_QUEUE_SDK_LOAD_FAILED":
    case "VERCEL_TOPIC_RESOLUTION_REQUIRED":
    case "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS":
      return value
  }
}

function parseQueueProvider(value: unknown): QueueProvider {
  if (value === "cloudflare" || value === "vercel") return value
  throw new TypeError("[vitehub] Invalid Queue error options.")
}

function parseQueueProviderOperation(value: unknown): Exclude<QueueProviderOperation, "load-sdk"> {
  if (value === "create-client" || value === "send" || value === "send-batch") return value
  throw new TypeError("[vitehub] Invalid Queue error options.")
}

function readDetails(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("[vitehub] Invalid Queue error options.")
  }
  return value as Record<string, unknown>
}

function validateFixedDetail(value: unknown, expected: string): void {
  if (value !== undefined && value !== expected) throw new TypeError("[vitehub] Invalid Queue error options.")
}

function parseUnsupportedOptions<TOption extends string>(
  value: unknown,
  allowed: readonly TOption[],
): readonly TOption[] {
  if (!Array.isArray(value)) throw new TypeError("[vitehub] Invalid Queue error options.")
  const unsupported = value.map((option) => {
    if (typeof option === "string" && allowed.includes(option as TOption)) return option as TOption
    throw new TypeError("[vitehub] Invalid Queue error options.")
  })
  return Object.freeze([...new Set(unsupported)])
}

function normalizeBuiltInDetails(code: QueueErrorCode, value: unknown): ViteHubErrorDetails | undefined {
  const details = readDetails(value)
  switch (code) {
    case "CLOUDFLARE_BINDING_INVALID":
    case "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED":
      validateFixedDetail(details?.provider, "cloudflare")
      return Object.freeze({ provider: "cloudflare" })
    case "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS":
      validateFixedDetail(details?.provider, "cloudflare")
      return Object.freeze({
        provider: "cloudflare",
        unsupported: parseUnsupportedOptions(details?.unsupported, ["idempotencyKey", "retentionSeconds"]),
      })
    case "QUEUE_DEFINITION_LOAD_FAILED":
    case "QUEUE_DEFINITION_NOT_FOUND": {
      const queue = normalizePublicQueueIdentifier(details?.queue)
      return queue ? Object.freeze({ queue }) : undefined
    }
    case "QUEUE_DISABLED":
      if (details) throw new TypeError("[vitehub] Invalid Queue error options.")
      return
    case "QUEUE_PROVIDER_OPERATION_FAILED":
      return Object.freeze({
        operation: parseQueueProviderOperation(details?.operation),
        provider: parseQueueProvider(details?.provider),
      })
    case "QUEUE_PROVIDER_RESPONSE_INVALID":
      validateFixedDetail(details?.operation, "send")
      validateFixedDetail(details?.provider, "vercel")
      return Object.freeze({ operation: "send", provider: "vercel" })
    case "VERCEL_PROVIDER_EXPECTED":
      return Object.freeze({ provider: parseQueueProvider(details?.provider) })
    case "VERCEL_QUEUE_REGION_REQUIRED":
    case "VERCEL_QUEUE_SDK_INVALID":
    case "VERCEL_TOPIC_RESOLUTION_REQUIRED":
      validateFixedDetail(details?.provider, "vercel")
      return Object.freeze({ provider: "vercel" })
    case "VERCEL_QUEUE_SDK_LOAD_FAILED":
      validateFixedDetail(details?.operation, "load-sdk")
      validateFixedDetail(details?.provider, "vercel")
      return Object.freeze({ operation: "load-sdk", provider: "vercel" })
    case "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS":
      validateFixedDetail(details?.provider, "vercel")
      return Object.freeze({
        provider: "vercel",
        unsupported: parseUnsupportedOptions(details?.unsupported, ["contentType"]),
      })
  }
}

function builtInQueueErrorMessage(code: QueueErrorCode, details: ViteHubErrorDetails | undefined): string {
  switch (code) {
    case "CLOUDFLARE_BINDING_INVALID":
      return "[vitehub] Cloudflare queue binding is invalid."
    case "CLOUDFLARE_BINDING_RESOLUTION_REQUIRED":
      return "[vitehub] Cloudflare queue requires a concrete request-scoped binding."
    case "CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS":
      return "[vitehub] Cloudflare queue does not support one or more enqueue options."
    case "QUEUE_DEFINITION_LOAD_FAILED":
      return "[vitehub] Queue Definition could not be loaded."
    case "QUEUE_DEFINITION_NOT_FOUND":
      return "[vitehub] Queue Definition is not registered. Queue Runtime Registry is installed by generated Provider Output."
    case "QUEUE_DISABLED":
      return "[vitehub] Queue runtime is disabled."
    case "QUEUE_PROVIDER_OPERATION_FAILED":
      return `[vitehub] ${details!.provider} queue provider failed during ${details!.operation}.`
    case "QUEUE_PROVIDER_RESPONSE_INVALID":
      return "[vitehub] Vercel queue provider returned an invalid send response."
    case "VERCEL_PROVIDER_EXPECTED":
      return "[vitehub] Hosted Vercel Queue Delivery requires the Vercel provider."
    case "VERCEL_QUEUE_REGION_REQUIRED":
      return "[vitehub] Vercel queue region could not be resolved."
    case "VERCEL_QUEUE_SDK_INVALID":
      return "[vitehub] Vercel queue SDK does not expose the expected client API."
    case "VERCEL_QUEUE_SDK_LOAD_FAILED":
      return "[vitehub] Vercel queue SDK could not be loaded."
    case "VERCEL_TOPIC_RESOLUTION_REQUIRED":
      return "[vitehub] Vercel queue requires a concrete topic."
    case "VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS":
      return "[vitehub] Vercel queue does not support one or more enqueue options."
  }
  throw new TypeError("[vitehub] Invalid Queue error options.")
}

function parseCustomQueueErrorCode(value: unknown): string {
  if (typeof value === "string" && /^[A-Z][A-Z\d]*(?:_[A-Z\d]+)*$/.test(value) && value.length <= 64) return value
  throw new TypeError("[vitehub] Invalid Queue error options.")
}

function parseCustomQueueErrorMessage(value: unknown): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 2048) return value
  throw new TypeError("[vitehub] Invalid Queue error options.")
}

function clonePublicDetail(
  value: unknown,
  seen: Set<object>,
  depth: number,
): ViteHubErrorDetail {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || depth > 8 || seen.has(value)) {
    throw new TypeError("[vitehub] Invalid Queue error options.")
  }

  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map(item => clonePublicDetail(item, seen, depth + 1)))
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("[vitehub] Invalid Queue error options.")
    }

    const result: Record<string, ViteHubErrorDetail | undefined> = {}
    const keys = Object.keys(value)
    if (keys.length > 100) throw new TypeError("[vitehub] Invalid Queue error options.")
    for (const key of keys) {
      if (key === "__proto__") throw new TypeError("[vitehub] Invalid Queue error options.")
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor)) throw new TypeError("[vitehub] Invalid Queue error options.")
      result[key] = descriptor.value === undefined
        ? undefined
        : clonePublicDetail(descriptor.value, seen, depth + 1)
    }
    return Object.freeze(result)
  }
  finally {
    seen.delete(value)
  }
}

function normalizeCustomDetails(value: unknown): ViteHubErrorDetails | undefined {
  if (value === undefined) return
  const details = clonePublicDetail(value, new Set(), 0)
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    throw new TypeError("[vitehub] Invalid Queue error options.")
  }
  return details as ViteHubErrorDetails
}

function normalizeQueueError(options: unknown): NormalizedQueueError {
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw new TypeError("[vitehub] Invalid Queue error options.")
    }
    const input = options as Record<string, unknown>
    const builtInCode = parseBuiltInQueueErrorCode(input.code)
    const code = builtInCode ?? parseCustomQueueErrorCode(input.code)
    const custom = input.custom === true
    if (custom === Boolean(builtInCode)) throw new TypeError("[vitehub] Invalid Queue error options.")

    const requestId = input.requestId === undefined
      ? undefined
      : normalizePublicQueueIdentifier(input.requestId)
    if (input.requestId !== undefined && requestId === undefined) {
      throw new TypeError("[vitehub] Invalid Queue error options.")
    }
    if (input.retryable !== undefined && (builtInCode || typeof input.retryable !== "boolean")) {
      throw new TypeError("[vitehub] Invalid Queue error options.")
    }

    const details = builtInCode
      ? normalizeBuiltInDetails(builtInCode, input.details)
      : normalizeCustomDetails(input.details)
    const message = builtInCode
      ? builtInQueueErrorMessage(builtInCode, details)
      : parseCustomQueueErrorMessage(input.message)

    return {
      cause: input.cause,
      code,
      details,
      message,
      requestId,
      retryable: builtInCode ? undefined : input.retryable as boolean | undefined,
    }
  }
  catch {
    throw new TypeError("[vitehub] Invalid Queue error options.")
  }
}

export class QueueError<TCode extends string = QueueErrorCode> extends ViteHubError<TCode, QueueErrorDetails<TCode>> {
  constructor(options: QueueErrorOptions<NoInfer<TCode>>) {
    const normalized = normalizeQueueError(options)
    super(normalized.code as TCode, normalized.message, {
      cause: normalized.cause,
      details: normalized.details as QueueErrorDetails<TCode> | undefined,
      requestId: normalized.requestId,
      retryable: normalized.retryable,
    })
    this.name = "QueueError"
    const shape = Object.freeze({
      code: normalized.code,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      message: normalized.message,
      ...(normalized.requestId === undefined ? {} : { requestId: normalized.requestId }),
      ...(normalized.retryable === undefined ? {} : { retryable: normalized.retryable }),
    })
    queueErrorPublicShapes.set(this, shape)
    Object.defineProperties(this, {
      code: { configurable: false, enumerable: true, value: normalized.code, writable: false },
      details: { configurable: false, enumerable: true, value: normalized.details, writable: false },
      message: { configurable: false, enumerable: false, value: normalized.message, writable: false },
      name: { configurable: false, enumerable: false, value: "QueueError", writable: false },
      requestId: { configurable: false, enumerable: true, value: normalized.requestId, writable: false },
      retryable: { configurable: false, enumerable: true, value: normalized.retryable, writable: false },
    })
    if (!Object.getOwnPropertyDescriptor(this, "toJSON")) {
      Object.defineProperty(this, "toJSON", {
        configurable: false,
        enumerable: false,
        value: this.toJSON.bind(this),
        writable: false,
      })
    }
  }

  override toJSON(): ViteHubErrorShape<TCode, QueueErrorDetails<TCode>> {
    const shape = queueErrorPublicShapes.get(this)
    if (!shape) throw new TypeError("[vitehub] Invalid Queue error instance.")
    return shape as ViteHubErrorShape<TCode, QueueErrorDetails<TCode>>
  }
}

export function getQueueErrorPublicShape(error: unknown): QueueErrorPublicShape | undefined {
  try {
    if (!(error instanceof QueueError)) return
    return queueErrorPublicShapes.get(error)
  }
  catch {
    return
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
  if (getQueueErrorPublicShape(error)) return true
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
    throw new QueueError<"QUEUE_PROVIDER_OPERATION_FAILED">({
      cause,
      code: "QUEUE_PROVIDER_OPERATION_FAILED",
      details: { operation, provider },
    })
  }
}
