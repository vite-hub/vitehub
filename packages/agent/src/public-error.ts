import {
  ApprovalRequiredError,
  CapabilityDeniedError,
  CapabilityNotFoundError,
} from "@vite-hub/runtime"

import { LlmGateRejectedError } from "./capabilities/llm-gate.ts"
import { RateLimitRejectedError } from "./capabilities/rate-limit.ts"

export type AgentPublicErrorCode =
  | "APPROVAL_REQUIRED"
  | "CAPABILITY_DENIED"
  | "CAPABILITY_NOT_FOUND"
  | "INTERNAL"
  | "LLM_GATE_REJECTED"
  | "RATE_LIMIT_REJECTED"

export interface AgentPublicErrorDetails {
  capability?: string
  category?: string
  retryAfter?: number
}

export interface AgentPublicError {
  code: AgentPublicErrorCode
  details?: AgentPublicErrorDetails
  error: string
  requestId?: string
}

export type AgentPublicErrorContext = "http" | "invocation" | "serialization"

const internalMessages: Record<AgentPublicErrorContext, string> = {
  http: "Agent request failed.",
  invocation: "Agent Invocation Stream failed.",
  serialization: "Agent Invocation Stream event could not be serialized.",
}

function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  }
  catch {
    return undefined
  }
}

function isInstance<T>(value: unknown, constructor: { prototype: T }): value is T {
  if (typeof value !== "object" || value === null) return false
  try {
    return Object.prototype.isPrototypeOf.call(constructor.prototype, value)
  }
  catch {
    return false
  }
}

function publicIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return
  return /^[A-Za-z0-9@][A-Za-z0-9@._:/-]*$/.test(value) ? value : undefined
}

function retryAfter(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function capabilityDetails(error: object): AgentPublicErrorDetails | undefined {
  const details = readProperty(error, "details")
  const capability = publicIdentifier(readProperty(error, "capabilityId"))
    || (details && typeof details === "object" ? publicIdentifier(readProperty(details, "capability")) : undefined)
  return capability ? { capability } : undefined
}

function requestId(error: ApprovalRequiredError): string | undefined {
  return publicIdentifier(readProperty(error, "requestId"))
}

export function toAgentPublicError(error: unknown, context: AgentPublicErrorContext): AgentPublicError {
  if (isInstance(error, RateLimitRejectedError)) {
    const details = capabilityDetails(error)
    const safeRetryAfter = retryAfter(readProperty(error, "retryAfter"))
    return {
      code: "RATE_LIMIT_REJECTED",
      ...(details ? { details: { ...details, ...(safeRetryAfter === undefined ? {} : { retryAfter: safeRetryAfter }) } } : {}),
      error: "Rate limit exceeded. Try again later.",
    }
  }

  if (isInstance(error, LlmGateRejectedError)) {
    const details = capabilityDetails(error)
    const decision = readProperty(error, "decision")
    const category = decision && typeof decision === "object"
      ? publicIdentifier(readProperty(decision, "category"))
      : undefined
    return {
      code: "LLM_GATE_REJECTED",
      ...(details ? { details: { ...details, ...(category === undefined ? {} : { category }) } } : {}),
      error: "Agent request was rejected.",
    }
  }

  if (isInstance(error, CapabilityNotFoundError)) {
    const details = capabilityDetails(error)
    return {
      code: "CAPABILITY_NOT_FOUND",
      ...(details ? { details } : {}),
      error: "Capability was not found.",
    }
  }

  if (isInstance(error, CapabilityDeniedError)) {
    const details = capabilityDetails(error)
    return {
      code: "CAPABILITY_DENIED",
      ...(details ? { details } : {}),
      error: "Capability access was denied.",
    }
  }

  if (isInstance(error, ApprovalRequiredError)) {
    const details = capabilityDetails(error)
    const safeRequestId = requestId(error)
    return {
      code: "APPROVAL_REQUIRED",
      ...(details ? { details } : {}),
      error: "Capability approval is required.",
      ...(safeRequestId === undefined ? {} : { requestId: safeRequestId }),
    }
  }

  return {
    code: "INTERNAL",
    error: internalMessages[context],
  }
}
