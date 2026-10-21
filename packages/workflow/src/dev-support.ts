import type { WorkflowProvider, WorkflowRunStatus } from "./types.ts"

/**
 * Guarded Workflow dev endpoint on the Vite Development Server.
 *
 * The endpoint exists only on the development server. It is not an
 * authenticated path to a deployed stage.
 */
export const workflowDevRoute = "/__vitehub/workflow/dev"
/**
 * Development-only Nitro route that runs Workflow operations in the Nitro dev runtime.
 * The Vite endpoint forwards `POST` requests to this route.
 */
export const workflowDevRuntimeRoute = "/_vitehub/workflow/dev"
export const workflowDevHeader = "x-vitehub-workflow-dev"
export const workflowDevHeaderValue = "1"
export const workflowDevLabel = "Workflow Dev"

export const workflowDevOperations = ["start", "get", "cancel", "resume"] as const
export type WorkflowDevOperation = typeof workflowDevOperations[number]

interface WorkflowDevOperationSupport {
  /** Explains what the Nitro dev runtime does, or why it cannot do the operation. */
  note: string
  supported: boolean
}

export type WorkflowDevSupport = Record<WorkflowDevOperation, WorkflowDevOperationSupport>

/**
 * `GET` response of the Workflow dev endpoint. `runtime` is `"nitro"` when the
 * Vite process runs Nitro, so the endpoint can forward operations to it.
 */
export interface WorkflowDevDiscovery {
  message?: string
  root: string
  runtime: "nitro" | "unavailable"
}

export type WorkflowDevRequest =
  | { input?: unknown, operation: "start", workflow: string }
  | { operation: "cancel" | "get", runId: string, workflow?: string }
  | { operation: "resume", payload?: unknown, token: string }

export interface WorkflowDevRunView {
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

export interface WorkflowDevSignalView {
  id: string
  provider: WorkflowProvider
}

interface WorkflowDevErrorBody {
  error: {
    code: string
    message: string
  }
}

export type WorkflowDevResponseBody =
  | { note?: string, run: WorkflowDevRunView }
  | { note?: string, signal: WorkflowDevSignalView }
  | WorkflowDevErrorBody

const inlineRunNote = "Runs the Workflow inline in the Nitro dev runtime, as the app does in development. Inline runs are not durable and have no retries."
const inlineReadNote = "Reads inline runs in the Nitro dev runtime, including runs that the app started. Finished inline runs expire after 5 minutes."

function unsupported(note: string): WorkflowDevOperationSupport {
  return { note, supported: false }
}

/**
 * Operations that the Workflow CLI supports for each provider in the Nitro dev runtime.
 *
 * Each note states what the command really does in development. Supported
 * operations can still fail when the runtime decides, for example cancel on an
 * inline Vercel run.
 */
export function resolveWorkflowDevSupport(provider: WorkflowProvider | null, reason?: string): WorkflowDevSupport {
  if (!provider) {
    const note = reason || "Workflow is disabled in this app."
    return { cancel: unsupported(note), get: unsupported(note), resume: unsupported(note), start: unsupported(note) }
  }
  if (provider === "cloudflare") {
    return {
      cancel: unsupported("Cloudflare Workflows do not support cancellation through ViteHub."),
      get: { note: `Reads the run from the Cloudflare Workflow binding when the Nitro dev runtime has one. ${inlineReadNote}`, supported: true },
      resume: unsupported("Cloudflare Workflows do not support ViteHub signals."),
      start: { note: `Uses the Cloudflare Workflow binding when the Nitro dev runtime has one. Otherwise: ${inlineRunNote}`, supported: true },
    }
  }
  if (provider === "openworkflow") {
    return {
      cancel: unsupported("OpenWorkflow does not support cancellation through ViteHub."),
      get: { note: "Reads the run from OpenWorkflow storage, including runs that the app started.", supported: true },
      resume: unsupported("OpenWorkflow does not support ViteHub signals."),
      start: { note: "Enqueues the run in OpenWorkflow storage. The run stays queued until an OpenWorkflow worker processes the same storage.", supported: true },
    }
  }
  return {
    cancel: { note: "Only native Vercel Workflow runs can be cancelled. Inline runs return an unsupported error.", supported: true },
    get: { note: `${inlineReadNote} Native Vercel Workflow runs need the Workflow DevKit runtime.`, supported: true },
    resume: { note: "Signals need a native Vercel Workflow run and the Workflow DevKit runtime.", supported: true },
    start: { note: `${inlineRunNote} Native Vercel Workflow Definitions need the Workflow DevKit runtime.`, supported: true },
  }
}
