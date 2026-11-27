import { parseDuration } from "@vite-hub/runtime"

import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

import type { WorkflowStartDelay } from "../types.ts"

const maximumTime = 8_640_000_000_000_000

function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === "[object Date]"
}

/**
 * The time in milliseconds when a delayed run starts, or `undefined` when the run starts now. A `Date` in the past
 * starts now. A duration that is not valid, such as a number, throws `RUNTIME_DURATION_INVALID`. An invalid `Date`, or
 * a time that a `Date` cannot hold, throws `WORKFLOW_START_DELAY_INVALID`.
 */
export function resolveWorkflowStartAt(delay: WorkflowStartDelay | undefined, now = Date.now()): number | undefined {
  if (delay === undefined) return undefined
  const startAt = isDate(delay) ? Date.prototype.getTime.call(delay) : now + parseDuration(delay, "delay")
  if (!Number.isFinite(startAt) || startAt > maximumTime) {
    throw workflowErrorDiagnostics.WORKFLOW_START_DELAY_INVALID({ delay: isDate(delay) ? "Invalid Date" : String(delay) })
  }
  return startAt > now ? startAt : undefined
}

/**
 * Holds the start time of a delayed run: in the Cloudflare params, next to the payload, and in the context of a
 * generated Vercel native entry. The handler never sees it.
 */
export const workflowStartAtKey = "~vitehubStartAt"

/** Marks the Vercel native entry that ViteHub generates for a folder Workflow. Only that entry reads the start time. */
export const generatedNativeEntryKey = "~vitehubGenerated"

/** Cloudflare `create()` has no delay, so a delayed run sends its start time next to the payload. */
export function toCloudflareStartParams(payload: unknown, startAt: number | undefined): unknown {
  return startAt === undefined ? payload : { [workflowStartAtKey]: startAt, payload }
}

/** Reads the params of a Cloudflare run. The handler gets only the payload. */
export function fromCloudflareStartParams(params: unknown): { payload: unknown, startAt?: number } {
  if (typeof params !== "object" || params === null || !Object.hasOwn(params, workflowStartAtKey)) return { payload: params }
  const startAt: unknown = Reflect.get(params, workflowStartAtKey)
  const keys = Object.keys(params)
  if (typeof startAt !== "number" || !keys.every(key => key === workflowStartAtKey || key === "payload")) return { payload: params }
  return { payload: Reflect.get(params, "payload"), startAt }
}
