import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorDetails } from "@vite-hub/runtime"

const workflowErrorMessages = {
  VERCEL_WORKFLOW_SDK_LOAD_FAILED: "Vercel Workflow DevKit load failed. Install the optional workflow peer dependency.",
  WORKFLOW_DEFINITION_NOT_FOUND: "Workflow definition was not found.",
  WORKFLOW_DISABLED: "Workflow is disabled.",
  WORKFLOW_NATIVE_ENTRY_INVALID: "Workflow has no transformed native Vercel entry.",
  WORKFLOW_NATIVE_ENTRY_REQUIRED: "Workflow has no native durable entry for Vercel.",
  WORKFLOW_OPERATION_UNSUPPORTED: "Workflow provider operation is unsupported.",
  WORKFLOW_PROVIDER_OPERATION_FAILED: "Workflow provider operation failed.",
  WORKFLOW_RUN_ID_UNSUPPORTED: "Native Vercel workflows assign their own run IDs.",
} as const

const workflowProviderNames = ["cloudflare", "openworkflow", "vercel"] as const
const workflowOperationNames = [
  "cancel",
  "cancellation",
  "connect",
  "create",
  "get",
  "get-run",
  "import",
  "list-steps",
  "resume-signal",
  "run",
  "signals",
  "start",
  "status",
] as const

const workflowProviders = new Set<string>(workflowProviderNames)
const workflowOperations = new Set<string>(workflowOperationNames)

const applicationCodePattern = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/
const safeWorkflowNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const maximumApplicationMessageLength = 512
const maximumApplicationDetailDepth = 5
const maximumApplicationDetailEntries = 64
const applicationDetailAccessor = Symbol("application detail accessor")
const trustedViteHubErrorToJSON = ViteHubError.prototype.toJSON

export type WorkflowErrorCode = keyof typeof workflowErrorMessages
export type WorkflowOperationName = typeof workflowOperationNames[number]
export type WorkflowProviderName = typeof workflowProviderNames[number]

type WorkflowNameDetails = {
  name?: string
}

type VercelWorkflowDetails = {
  name?: string
  provider: "vercel"
}

type WorkflowOperationDetails = {
  operation: WorkflowOperationName
  provider: WorkflowProviderName
}

type WorkflowProviderOperationDetails = WorkflowOperationDetails & {
  status?: number
}

type VercelSdkDetails = {
  provider: "vercel"
}

export type WorkflowErrorDetails<TCode extends WorkflowErrorCode = WorkflowErrorCode> =
  TCode extends "VERCEL_WORKFLOW_SDK_LOAD_FAILED" ? VercelSdkDetails
    : TCode extends "WORKFLOW_DEFINITION_NOT_FOUND" ? WorkflowNameDetails
      : TCode extends "WORKFLOW_DISABLED" ? never
        : TCode extends "WORKFLOW_NATIVE_ENTRY_INVALID" | "WORKFLOW_NATIVE_ENTRY_REQUIRED" | "WORKFLOW_RUN_ID_UNSUPPORTED" ? VercelWorkflowDetails
          : TCode extends "WORKFLOW_OPERATION_UNSUPPORTED" ? WorkflowOperationDetails
            : TCode extends "WORKFLOW_PROVIDER_OPERATION_FAILED" ? WorkflowProviderOperationDetails
              : never

type WorkflowErrorOptionsFor<TCode extends WorkflowErrorCode> = ErrorOptions & {
  code: TCode
} & (TCode extends "WORKFLOW_DISABLED"
  ? { details?: never }
  : TCode extends "WORKFLOW_DEFINITION_NOT_FOUND"
    ? { details?: WorkflowErrorDetails<TCode> }
    : { details: WorkflowErrorDetails<TCode> })

export type WorkflowErrorOptions<TCode extends WorkflowErrorCode = WorkflowErrorCode> =
  TCode extends WorkflowErrorCode ? WorkflowErrorOptionsFor<TCode> : never

type WorkflowErrorConstructorOptions<TCode extends WorkflowErrorCode> =
  [WorkflowErrorCode] extends [TCode]
    ? ErrorOptions & { code: TCode, details: WorkflowErrorDetails<TCode> }
    : WorkflowErrorOptions<TCode>

export class WorkflowError<TCode extends WorkflowErrorCode = WorkflowErrorCode> extends ViteHubError<TCode, WorkflowErrorDetails<TCode>> {
  constructor(options: WorkflowErrorConstructorOptions<TCode>) {
    const code = readOption(options, "code")
    if (typeof code !== "string" || !Object.hasOwn(workflowErrorMessages, code)) {
      throw new TypeError("WorkflowError requires a known workflow error code.")
    }

    const details = safeWorkflowErrorDetails(code as WorkflowErrorCode, readOption(options, "details"))
    const cause = readOption(options, "cause")
    super(code as TCode, workflowErrorMessages[code as WorkflowErrorCode], {
      ...(cause === undefined ? {} : { cause }),
      ...(details === undefined ? {} : { details: details as WorkflowErrorDetails<TCode> }),
    })
    this.name = "WorkflowError"
    sealPublicError(this)
  }
}

export interface ApplicationWorkflowErrorOptions<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends ErrorOptions {
  code: TCode
  details?: TDetails
  message: string
}

export class ApplicationWorkflowError<
  TCode extends string = string,
  TDetails extends ViteHubErrorDetails = ViteHubErrorDetails,
> extends ViteHubError<TCode, TDetails> {
  constructor(options: ApplicationWorkflowErrorOptions<TCode, TDetails>) {
    const code = readOption(options, "code")
    if (typeof code !== "string" || code.length > 64 || !applicationCodePattern.test(code) || Object.hasOwn(workflowErrorMessages, code)) {
      throw new TypeError("ApplicationWorkflowError requires a non-reserved SCREAMING_SNAKE_CASE code of at most 64 characters.")
    }

    const message = readOption(options, "message")
    if (typeof message !== "string" || message.length === 0 || message.length > maximumApplicationMessageLength) {
      throw new TypeError("ApplicationWorkflowError requires a message between 1 and 512 characters.")
    }

    const cause = readOption(options, "cause")
    const rawDetails = readOption(options, "details")
    const details = rawDetails === undefined ? undefined : cloneApplicationDetails(rawDetails)
    super(code as TCode, message, {
      ...(cause === undefined ? {} : { cause }),
      ...(details === undefined ? {} : { details: details as TDetails }),
    })
    this.name = "ApplicationWorkflowError"
    sealPublicError(this)
  }
}

function readOption(options: unknown, key: "cause" | "code" | "details" | "message"): unknown {
  if ((typeof options !== "object" || options === null) && typeof options !== "function") return undefined
  try {
    return Reflect.get(options, key)
  }
  catch {
    return undefined
  }
}

function safeWorkflowErrorDetails(code: WorkflowErrorCode, details: unknown): ViteHubErrorDetails | undefined {
  if (typeof details !== "object" || details === null) return undefined

  const name = safeStringProperty(details, "name", value => safeWorkflowNamePattern.test(value))
  const operation = safeStringProperty(details, "operation", value => workflowOperations.has(value))
  const provider = safeStringProperty(details, "provider", value => workflowProviders.has(value)) as WorkflowProviderName | undefined
  const status = safeNumberProperty(details, "status", value => Number.isInteger(value) && value >= 400 && value <= 599)

  switch (code) {
    case "VERCEL_WORKFLOW_SDK_LOAD_FAILED":
      return provider === "vercel" ? { provider } : undefined
    case "WORKFLOW_DEFINITION_NOT_FOUND":
      return name ? { name } : undefined
    case "WORKFLOW_DISABLED":
      return undefined
    case "WORKFLOW_NATIVE_ENTRY_INVALID":
    case "WORKFLOW_NATIVE_ENTRY_REQUIRED":
    case "WORKFLOW_RUN_ID_UNSUPPORTED":
      return provider === "vercel" ? { ...(name ? { name } : {}), provider } : undefined
    case "WORKFLOW_OPERATION_UNSUPPORTED":
      return operation && provider ? { operation, provider } : undefined
    case "WORKFLOW_PROVIDER_OPERATION_FAILED":
      return operation && provider ? { operation, provider, ...(status === undefined ? {} : { status }) } : undefined
  }
}

function safeStringProperty(value: object, key: string, accepts: (value: string) => boolean): string | undefined {
  try {
    const property = Reflect.get(value, key)
    return typeof property === "string" && accepts(property) ? property : undefined
  }
  catch {
    return undefined
  }
}

function safeNumberProperty(value: object, key: string, accepts: (value: number) => boolean): number | undefined {
  try {
    const property = Reflect.get(value, key)
    return typeof property === "number" && accepts(property) ? property : undefined
  }
  catch {
    return undefined
  }
}

function cloneApplicationDetails(value: unknown): ViteHubErrorDetails {
  const state = { entries: 0, seen: new Set<object>() }
  const result = cloneApplicationDetailValue(value, 0, state)
  if (!isPlainObject(result)) {
    throw new TypeError("ApplicationWorkflowError details must be a JSON-safe plain object.")
  }
  return result as ViteHubErrorDetails
}

function cloneApplicationDetailValue(value: unknown, depth: number, state: { entries: number, seen: Set<object> }): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value
    throw new TypeError("ApplicationWorkflowError details must contain only finite numbers.")
  }
  if (typeof value !== "object") {
    throw new TypeError("ApplicationWorkflowError details must be JSON-safe.")
  }
  if (depth >= maximumApplicationDetailDepth) {
    throw new TypeError("ApplicationWorkflowError details exceed the maximum depth of 5.")
  }
  if (state.seen.has(value)) {
    throw new TypeError("ApplicationWorkflowError details must not contain cycles.")
  }

  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const length = safeArrayLength(value)
      countApplicationEntries(state, length)
      return Array.from({ length }, (_, index) => cloneApplicationDetailValue(readApplicationValue(value, String(index)), depth + 1, state))
    }
    if (!isPlainObject(value)) {
      throw new TypeError("ApplicationWorkflowError details must contain only plain objects and arrays.")
    }

    const keys = safeApplicationKeys(value)
    countApplicationEntries(state, keys.length)
    const entries = keys
      .map(key => [key, readApplicationValue(value, key)] as const)
      .filter(([, nested]) => nested !== undefined)
    return Object.fromEntries(entries.map(([key, nested]) => [key, cloneApplicationDetailValue(nested, depth + 1, state)]))
  }
  finally {
    state.seen.delete(value)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }
  catch {
    return false
  }
}

function safeArrayLength(value: readonly unknown[]): number {
  try {
    const length = Reflect.get(value, "length")
    if (typeof length === "number" && Number.isSafeInteger(length) && length >= 0) return length
  }
  catch {
    // Fall through to the fixed public error below.
  }
  throw new TypeError("ApplicationWorkflowError details contain an invalid array.")
}

function safeApplicationKeys(value: object): string[] {
  try {
    return Object.keys(value)
  }
  catch {
    throw new TypeError("ApplicationWorkflowError details contain an unreadable object.")
  }
}

function readApplicationValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) {
      throw applicationDetailAccessor
    }
    return descriptor.value
  }
  catch (error) {
    if (error === applicationDetailAccessor) {
      throw new TypeError("ApplicationWorkflowError details must not contain accessors.")
    }
    throw new TypeError("ApplicationWorkflowError details contain an unreadable value.")
  }
}

function countApplicationEntries(state: { entries: number }, count: number): void {
  state.entries += count
  if (state.entries > maximumApplicationDetailEntries) {
    throw new TypeError("ApplicationWorkflowError details exceed the maximum of 64 entries.")
  }
}

function sealPublicError(error: ViteHubError<string, ViteHubErrorDetails>): void {
  deepFreeze(error.details)
  Object.defineProperty(error, "toJSON", {
    configurable: false,
    value: () => trustedViteHubErrorToJSON.call(error),
    writable: false,
  })
  for (const key of ["code", "details", "message", "name", "requestId", "retryable"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    if (descriptor && "writable" in descriptor) {
      Object.defineProperty(error, key, { ...descriptor, configurable: false, writable: false })
    }
  }
}

function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return
  for (const nested of Object.values(value)) deepFreeze(nested)
  Object.freeze(value)
}
