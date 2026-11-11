import { isBlockingServerEnvEntry } from "@vite-hub/env"
import { runWithCloudflareEnv } from "@vite-hub/env/internal/server"
import { consoleState } from "../../internal.ts"
import type { ServerEnvDescription, ServerEnvInspection, ServerEnvInspectionEntry } from "@vite-hub/env"
import type { ConsoleEnvInspection } from "../../internal.ts"
import type { ConsoleRequestEvent } from "./request.ts"

export type ConsoleEnvStatusEntry = Pick<ServerEnvInspectionEntry, "path" | "status"> & {
  /** The entry makes `loadServerEnv()` fail. */
  blocking: boolean
}

export type ConsoleEnvResponse = ServerEnvDescription & {
  /** Present only when the request asks for status. */
  status?: ConsoleEnvStatusEntry[]
}

export function installConsoleEnv(
  projectRoot: string,
  description: ServerEnvDescription,
  inspect?: (event: ConsoleRequestEvent) => Promise<ServerEnvInspection>,
): ConsoleEnvInspection {
  const scope: ConsoleEnvInspection = { ...description }
  if (inspect) scope.inspect = inspect
  return consoleState().env = scope
}

export function getConsoleEnv(): ServerEnvDescription {
  return { entries: consoleState().env?.entries ?? [] }
}

/** Returns declaration metadata with status from `inspectServerEnv()`. Values never leave the owner package. */
export async function getConsoleEnvStatus(event: ConsoleRequestEvent): Promise<ConsoleEnvResponse | undefined> {
  const inspection = consoleState().env
  if (!inspection?.inspect) return undefined
  const inspect = inspection.inspect
  const { entries } = await runWithCloudflareEnv(event["~standard"].runtime?.cloudflare?.env ?? {}, () => inspect(event))
  const status = entries.map((entry) => {
    const statusEntry: ConsoleEnvStatusEntry = {
      blocking: isBlockingServerEnvEntry(entry),
      status: entry.status,
    }
    if (entry.path) statusEntry.path = entry.path
    return statusEntry
  })
  return {
    entries: inspection.entries,
    status,
  }
}
