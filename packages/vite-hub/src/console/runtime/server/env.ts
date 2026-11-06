import { consoleDiagnosticBody } from "../diagnostics.ts"
import { isBlockingServerEnvEntry } from "@vite-hub/env"
import { installStandardContext } from "@vite-hub/runtime/h3"
import { installConsoleEnvScope, resolveConsoleEnv } from "../../internal.ts"
import type { ServerEnvDescription, ServerEnvInspection, ServerEnvInspectionEntry } from "@vite-hub/env"
import type { ConsoleEnvInspection } from "../../internal.ts"
import type { ConsoleRequestEvent } from "./request.ts"
import type { ViteHubContext } from "@vite-hub/runtime"
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
  inspect?: (event: ConsoleRequestEvent & ViteHubContext) => Promise<ServerEnvInspection>,
): ConsoleEnvInspection {
  const scope: ConsoleEnvInspection = { ...description }
  if (inspect) scope.inspect = inspect
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
  installStandardContext(event)
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
  if (!manage) return Response.json(consoleDiagnosticBody("CONSOLE_ENV_MANAGEMENT_UNAVAILABLE"), { status: 404, headers: { "cache-control": "no-store" } })
  return manage(request)
}
