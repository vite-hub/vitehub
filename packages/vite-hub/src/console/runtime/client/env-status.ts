import type { ServerEnvDescriptionEntry } from "@vite-hub/env"
import type { ConsoleEnvStatusEntry } from "../server/env.ts"

/** Description and inspection use the same registry traversal order, including undisclosed names. */
export function indexEnvStatuses(entries: readonly ServerEnvDescriptionEntry[], statuses: readonly ConsoleEnvStatusEntry[]): ReadonlyMap<ServerEnvDescriptionEntry, ConsoleEnvStatusEntry> {
  return new Map(entries.flatMap((entry, index) => {
    const status = statuses[index]
    return status ? [[entry, status] as const] : []
  }))
}
