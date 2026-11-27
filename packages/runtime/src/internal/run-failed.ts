/** The error of a failed run: its message and, for a ViteHub error, its code. */
export interface RunFailedError {
  message: string
  code?: string
}

/** A run that ended in failure: no retry is left. Agent, Workflow, and Schedule emit it, and Webhooks sends it. */
export type RunFailedEvent =
  | { event: "invocation.failed", agent: string | null, invocationId: string, error: RunFailedError, failedAt: string }
  | { event: "workflow.failed", workflow: string, runId: string, error: RunFailedError, failedAt: string }
  | { event: "schedule.failed", schedule: string, runId: string, error: RunFailedError, failedAt: string }

export type RunFailedEventName = RunFailedEvent["event"]

export const runFailedEventNames: readonly RunFailedEventName[] = ["invocation.failed", "schedule.failed", "workflow.failed"]

export type RunFailedListener = (event: RunFailedEvent) => unknown

const listenersKey = Symbol.for("vitehub.runtime.runFailedListeners")

function listeners(): Set<RunFailedListener> {
  const runtimeGlobal = globalThis as typeof globalThis & { [listenersKey]?: Set<RunFailedListener> }
  return runtimeGlobal[listenersKey] ??= new Set()
}

/** Calls `listener` for each run that ends in failure in this process. Returns a function that removes it. */
export function onRunFailed(listener: RunFailedListener): () => void {
  listeners().add(listener)
  return () => {
    listeners().delete(listener)
  }
}

const maxMessageLength = 2000

/** The message and code of a thrown value. */
export function toRunFailedError(error: unknown): RunFailedError {
  const record = typeof error === "object" && error !== null ? error : undefined
  let message: string
  let code: unknown
  try {
    const value: unknown = record && "message" in record ? Reflect.get(record, "message") : error
    message = typeof value === "string" ? value : String(value)
  }
  catch {
    message = "[unprintable thrown value]"
  }
  try {
    code = record ? Reflect.get(record, "code") : undefined
  }
  catch {
    code = undefined
  }
  return {
    message: message.length > maxMessageLength ? `${message.slice(0, maxMessageLength)}…` : message,
    ...(typeof code === "string" && code ? { code } : {}),
  }
}

/**
 * Tells the listeners that a run ended in failure. Call it once, when no retry is left. It waits for the listeners, so a
 * serverless host keeps the work alive, and it never throws: an alert that fails must not change the run.
 */
export async function emitRunFailed(event: RunFailedEvent): Promise<void> {
  const current = [...listeners()]
  if (!current.length) return
  const results = await Promise.allSettled(current.map(async listener => await listener(event)))
  for (const result of results) {
    if (result.status === "rejected") console.error(`[vitehub] A listener of ${event.event} failed.`, result.reason)
  }
}

export function hasRunFailedListeners(): boolean {
  return listeners().size > 0
}
