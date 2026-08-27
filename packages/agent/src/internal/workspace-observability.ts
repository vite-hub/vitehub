import type { TraceContext, TraceEventLog } from "@vite-hub/runtime"
import type {
  WorkspaceMaterializeSourcesProgressEvent,
  WorkspacePrepareSessionProgressEvent,
} from "@vite-hub/workspace"

interface WorkspaceSetupObserversOptions {
  invocationId?: string
  runId?: string
  trace?: TraceContext
  traceLog?: TraceEventLog
  workspace?: string
}

export interface WorkspaceSetupObservers {
  materialization: (event: WorkspaceMaterializeSourcesProgressEvent) => Promise<void>
  preparation: (event: WorkspacePrepareSessionProgressEvent) => Promise<void>
}

function readableBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function detail(parts: Array<string | undefined>): string | undefined {
  const values = parts.filter((part): part is string => Boolean(part))
  return values.length ? values.join(" · ") : undefined
}

function filesDetail(files: number | undefined): string | undefined {
  return files === undefined ? undefined : `${files} file${files === 1 ? "" : "s"}`
}

function revisionAttributes(revision: WorkspaceMaterializeSourcesProgressEvent["revision"]) {
  return revision
    ? {
        "workspace.source.revision.id": revision.id,
        "workspace.source.revision.immutable": revision.immutable,
        "workspace.source.revision.ref": revision.ref,
      }
    : {}
}

function eventSuffix(status: WorkspaceMaterializeSourcesProgressEvent["status"] | WorkspacePrepareSessionProgressEvent["status"]) {
  if (status === "started") return "start"
  if (status === "updating") return "progress"
  if (status === "failed") return "error"
  return "finish"
}

async function append(traceLog: TraceEventLog | undefined, event: Parameters<TraceEventLog["append"]>[0]): Promise<void> {
  try {
    await traceLog?.append(event)
  }
  catch {
    // Invocation tracing must never make Workspace setup fail.
  }
}

function correlatedEvent(
  options: WorkspaceSetupObserversOptions,
  event: Parameters<TraceEventLog["append"]>[0],
): Parameters<TraceEventLog["append"]>[0] {
  return {
    ...event,
    trace: event.trace || options.trace,
    attributes: {
      ...(options.invocationId ? { "agent.invocation.id": options.invocationId } : {}),
      ...(options.runId ? { "agent.run.id": options.runId } : {}),
      ...event.attributes,
    },
  }
}

export function createWorkspaceSetupObservers(options: WorkspaceSetupObserversOptions): WorkspaceSetupObservers {
  return {
    async materialization(event) {
      const counts = event.counts
      const stepId = `vitehub.workspace.materialization:${event.source}:${event.path || "."}`
      const title = event.status === "failed"
        ? "Workspace source failed"
        : event.status === "completed"
          ? "Workspace source materialized"
          : "Materializing workspace source"
      await append(options.traceLog, correlatedEvent(options, {
        attributes: {
          "error.message": event.error,
          "step.id": stepId,
          "vitehub.activity.detail": detail([
            event.source,
            event.provider,
            filesDetail(event.files),
            readableBytes(event.bytes),
            event.cacheStatus ? `cache ${event.cacheStatus}` : undefined,
            event.revision?.id,
          ]),
          "vitehub.activity.kind": "preparation",
          "vitehub.activity.title": title,
          "vitehub.inspect.target": "workspace",
          "workspace.materialization.bytes": event.bytes,
          "workspace.materialization.cache.status": event.cacheStatus,
          "workspace.materialization.count.added": counts?.added,
          "workspace.materialization.count.removed": counts?.removed,
          "workspace.materialization.count.unchanged": counts?.unchanged,
          "workspace.materialization.count.updated": counts?.updated,
          "workspace.materialization.directories": event.directories,
          "workspace.materialization.durationMs": event.durationMs,
          "workspace.materialization.files": event.files,
          "workspace.materialization.path": event.path,
          "workspace.materialization.status": event.status,
          "workspace.name": options.workspace,
          "workspace.source": event.source,
          "workspace.source.mount": event.mountPath,
          "workspace.source.provider": event.provider,
          ...revisionAttributes(event.revision),
        },
        name: event.status === "completed"
          ? "vitehub.workspace.materialized"
          : event.status === "failed"
            ? "vitehub.workspace.error"
            : `vitehub.workspace.materialization.${eventSuffix(event.status)}`,
        type: event.status === "failed" ? "error" : "lifecycle",
      }))
    },
    async preparation(event) {
      const bytes = typeof event.data?.bytes === "number" ? event.data.bytes : undefined
      const files = typeof event.data?.files === "number" ? event.data.files : undefined
      const revision = typeof event.data?.revision === "string" ? event.data.revision : undefined
      const stepId = `vitehub.${event.id}`
      await append(options.traceLog, correlatedEvent(options, {
        attributes: {
          "error.message": event.error,
          "step.id": stepId,
          "vitehub.activity.detail": detail([filesDetail(files), readableBytes(bytes), revision]),
          "vitehub.activity.kind": "preparation",
          "vitehub.activity.title": event.label,
          "vitehub.inspect.target": "workspace",
          "workspace.name": options.workspace,
          "workspace.preparation.bytes": bytes,
          "workspace.preparation.durationMs": event.durationMs,
          "workspace.preparation.files": files,
          "workspace.preparation.revision": revision,
          "workspace.preparation.status": event.status,
        },
        name: `${stepId}.${eventSuffix(event.status)}`,
        type: event.status === "failed" ? "error" : "lifecycle",
      }))
    },
  }
}
