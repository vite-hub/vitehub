import type { WorkflowProvider, WorkflowRunStatus } from "./types.ts"

/** One Workflow run as the operations return it. The start payload is not included. */
export interface WorkflowRunView {
  completedAt?: string
  createdAt?: string
  error?: { code?: string, message: string, name?: string }
  id: string
  metadata?: unknown
  provider: WorkflowProvider
  result?: unknown
  startedAt?: string
  status: WorkflowRunStatus
  workflow: string
}

/** The signal that `workflow.resume` delivered. */
export interface WorkflowSignalView {
  id: string
  provider: WorkflowProvider
}

export interface WorkflowRunResult {
  run: WorkflowRunView
}

export interface WorkflowSignalResult {
  signal: WorkflowSignalView
}

export type WorkflowOperationName = "cancel" | "get" | "resume" | "start"

interface WorkflowOperationSupport {
  /** Explains what the runtime does, or why it cannot do the operation. */
  note: string
  supported: boolean
}

const inlineRunNote = "Runs the Workflow inline in the Nitro runtime, as the app does in development. Inline runs are not durable and have no retries."

function unsupported(note: string): WorkflowOperationSupport {
  return { note, supported: false }
}

/**
 * Operations that each provider supports. A supported operation can still fail when the runtime decides, for example
 * cancel on an inline Vercel run.
 */
export function resolveWorkflowOperationSupport(provider: WorkflowProvider): Record<WorkflowOperationName, WorkflowOperationSupport> {
  if (provider === "cloudflare") {
    return {
      cancel: unsupported("Cloudflare Workflows do not support cancellation through ViteHub."),
      get: { note: "Reads the run from the Cloudflare Workflow binding when the runtime has one.", supported: true },
      resume: unsupported("Cloudflare Workflows do not support ViteHub signals."),
      start: { note: `Uses the Cloudflare Workflow binding when the runtime has one. Otherwise: ${inlineRunNote}`, supported: true },
    }
  }
  if (provider === "openworkflow") {
    return {
      cancel: unsupported("OpenWorkflow does not support cancellation through ViteHub."),
      get: { note: "Reads the run from OpenWorkflow storage.", supported: true },
      resume: unsupported("OpenWorkflow does not support ViteHub signals."),
      start: { note: "Enqueues the run in OpenWorkflow storage. The run stays queued until an OpenWorkflow worker processes the same storage.", supported: true },
    }
  }
  return {
    cancel: { note: "Only native Vercel Workflow runs can be cancelled. Inline runs return an unsupported error.", supported: true },
    get: { note: "Reads inline runs, which expire 5 minutes after they finish. Native Vercel Workflow runs need the Workflow DevKit runtime.", supported: true },
    resume: { note: "Signals need a native Vercel Workflow run and the Workflow DevKit runtime.", supported: true },
    start: { note: `${inlineRunNote} Native Vercel Workflow Definitions need the Workflow DevKit runtime.`, supported: true },
  }
}
