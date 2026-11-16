import { workflowErrorDiagnostics } from "../error-diagnostics.ts"

import type { WorkflowStartDelay } from "../types.ts"

const durationUnits: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
}

/** The largest time that a JavaScript Date can hold. */
const maximumTime = 8_640_000_000_000_000

function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === "[object Date]"
}

function parseDelayMilliseconds(delay: number | string): number | undefined {
  if (typeof delay === "number") return Number.isFinite(delay) && delay >= 0 ? delay : undefined
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(delay.trim())
  const unit = match && durationUnits[match[2]!.toLowerCase()]
  return unit ? Number(match[1]) * unit : undefined
}

/**
 * The time in milliseconds when a delayed run starts, or `undefined` when the run starts now. A `Date` in the past
 * starts now. A negative, unknown, or invalid delay throws `WORKFLOW_START_DELAY_INVALID`.
 */
export function resolveWorkflowStartAt(delay: WorkflowStartDelay | undefined, now = Date.now()): number | undefined {
  if (delay === undefined) return undefined
  let startAt: number | undefined
  if (isDate(delay)) startAt = Date.prototype.getTime.call(delay)
  else if (typeof delay === "number" || typeof delay === "string") {
    const milliseconds = parseDelayMilliseconds(delay)
    startAt = milliseconds === undefined ? undefined : now + milliseconds
  }
  if (startAt === undefined || !Number.isFinite(startAt) || startAt > maximumTime) {
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
