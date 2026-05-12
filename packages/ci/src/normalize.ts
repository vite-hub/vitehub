import type { CITrigger, CIRunOutcome, CIRunStatus } from "./types.ts"

export function normalizeKnownTrigger(value: unknown): CITrigger {
  const trigger = String(value ?? "").toLowerCase()
  if (trigger === "push") return "push"
  if (trigger === "pull_request" || trigger === "pull-request" || trigger === "pull_request_event") return "pull_request"
  if (trigger === "manual" || trigger === "workflow_dispatch") return "manual"
  if (trigger === "api") return "api"
  if (trigger === "schedule" || trigger === "scheduled") return "schedule"
  return "unknown"
}

export function normalizeGithubStatus(status: unknown): CIRunStatus {
  switch (String(status ?? "").toLowerCase()) {
    case "queued":
    case "waiting":
    case "requested":
    case "pending":
      return "queued"
    case "in_progress":
      return "running"
    case "completed":
      return "completed"
    default:
      return "unknown"
  }
}

export function normalizeGithubConclusion(conclusion: unknown): CIRunOutcome | undefined {
  switch (String(conclusion ?? "").toLowerCase()) {
    case "":
    case "null":
    case "undefined":
      return undefined
    case "success":
      return "success"
    case "failure":
    case "action_required":
      return "failed"
    case "cancelled":
      return "cancelled"
    case "skipped":
    case "neutral":
      return "skipped"
    case "timed_out":
      return "timed_out"
    default:
      return "unknown"
  }
}

export function normalizeCloudflareStatus(status: unknown): CIRunStatus {
  switch (String(status ?? "").toLowerCase()) {
    case "queued":
      return "queued"
    case "initializing":
      return "initializing"
    case "running":
      return "running"
    case "stopped":
      return "completed"
    default:
      return "unknown"
  }
}

export function normalizeCloudflareOutcome(outcome: unknown): CIRunOutcome | undefined {
  switch (String(outcome ?? "").toLowerCase()) {
    case "":
    case "null":
    case "undefined":
      return undefined
    case "success":
      return "success"
    case "fail":
    case "failed":
      return "failed"
    case "cancelled":
    case "canceled":
    case "terminated":
      return "cancelled"
    case "skipped":
      return "skipped"
    default:
      return "unknown"
  }
}

export function normalizeVercelStatus(value: unknown): CIRunStatus {
  switch (String(value ?? "").toLowerCase()) {
    case "queued":
    case "pending":
      return "queued"
    case "building":
    case "deploying":
    case "initializing":
      return "running"
    case "ready":
    case "error":
    case "canceled":
    case "cancelled":
      return "completed"
    default:
      return "unknown"
  }
}

export function normalizeVercelOutcome(value: unknown): CIRunOutcome | undefined {
  switch (String(value ?? "").toLowerCase()) {
    case "ready":
      return "success"
    case "error":
      return "failed"
    case "canceled":
    case "cancelled":
      return "cancelled"
    case "":
    case "null":
    case "undefined":
    case "building":
    case "queued":
    case "pending":
    case "deploying":
    case "initializing":
      return undefined
    default:
      return "unknown"
  }
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

export function epochOrStringToISOString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000
    return new Date(milliseconds).toISOString()
  }
  return undefined
}

