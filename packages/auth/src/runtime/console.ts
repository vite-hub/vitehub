import { getAuthEvents } from "../server.ts"
import type { ViteHubConsoleRecord, ViteHubConsoleRuntimeRecordReader } from "@vite-hub/internal/console"

/** Owner runtime reader. The Console must authorize access before it calls this export. */
export const readAuthEventConsoleRecords: ViteHubConsoleRuntimeRecordReader = async (): Promise<ViteHubConsoleRecord[]> => {
  const store = getAuthEvents()
  if (!store) return []
  const { events } = await store.list()
  return events.map(event => ({
    id: event.id,
    cells: { type: event.type, time: event.time, actor: event.actor, user: event.userId ?? "", method: event.metadata.method ?? "" },
    fields: [
      { label: "Type", value: event.type }, { label: "Time", value: event.time },
      { label: "Actor", value: event.actor }, { label: "User", value: event.userId ?? "Unknown" },
      { label: "Metadata", value: JSON.stringify(event.metadata) },
    ],
  }))
}

// Structured readers retain filters, cursors, and window totals for the later Activity and Overview views.
export { aggregateAuthEvents, listAuthEvents } from "../server.ts"
