import type { WorkspacePrepareSessionProgressEvent } from "../core/types.ts"

export async function withWorkspaceProgress<T>(
  onProgress: ((event: WorkspacePrepareSessionProgressEvent) => void | Promise<void>) | undefined,
  event: Pick<WorkspacePrepareSessionProgressEvent, "id" | "label"> & { data?: Record<string, unknown> },
  fn: () => Promise<T>,
) {
  const startedAt = Date.now()
  await onProgress?.({ data: event.data, id: event.id, label: event.label, status: "started" })
  try {
    const result = await fn()
    await onProgress?.({
      data: event.data,
      durationMs: Date.now() - startedAt,
      id: event.id,
      label: event.label,
      status: "completed",
    })
    return result
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await onProgress?.({
      data: { ...event.data, error: message },
      durationMs: Date.now() - startedAt,
      error: message,
      id: event.id,
      label: event.label,
      status: "failed",
    })
    throw error
  }
}
