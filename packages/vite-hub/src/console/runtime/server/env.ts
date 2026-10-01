import { isBlockingServerEnvEntry } from "@vite-hub/env"
import { installConsoleEnvScope, resolveConsoleEnv } from "../../internal.ts"
import type { ServerEnvDescription, ServerEnvInspection, ServerEnvInspectionEntry } from "@vite-hub/env"
import type { ConsoleEnvInspection } from "../../internal.ts"
import type { ConsoleRequestEvent } from "./request.ts"
import { getConsoleSections } from "./sections.ts"

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
  manage?: (request: Request) => Promise<Response>,
  inspect?: (event: ConsoleRequestEvent) => Promise<ServerEnvInspection>,
): ConsoleEnvInspection {
  const scope: ConsoleEnvInspection = { ...description }
  if (inspect) {
    // SAFETY: This callback is invoked only by getConsoleEnvStatus with a ConsoleRequestEvent.
    scope.inspect = event => inspect(event as ConsoleRequestEvent)
  }
  if (manage) scope.manage = manage
  return installConsoleEnvScope(projectRoot, scope)
}

export function getConsoleEnv(): ServerEnvDescription {
  return { entries: resolveConsoleEnv()?.entries ?? [] }
}

/** Returns declaration metadata with status from `inspectServerEnv()`. Values never leave the owner package. */
export async function getConsoleEnvStatus(event: ConsoleRequestEvent): Promise<ConsoleEnvResponse | undefined> {
  const inspection = resolveConsoleEnv()
  if (!inspection?.inspect) return undefined
  const { entries } = await inspection.inspect(event)
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

export async function manageConsoleEnv(request: Request): Promise<Response> {
  const manage = getConsoleSections().includes("env") ? resolveConsoleEnv()?.manage : undefined
  if (!manage) return Response.json({ message: "Env management is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } })
  return manage(request)
}
