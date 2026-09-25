import { installConsoleEnvScope, resolveConsoleEnv } from "../../internal.ts"
import type { ServerEnvDescription } from "@vite-hub/env"
import { getConsoleSections } from "./sections.ts"

export function installConsoleEnv(projectRoot: string, description: ServerEnvDescription, manage?: (request: Request) => Promise<Response>): ServerEnvDescription {
  return installConsoleEnvScope(projectRoot, { ...description, ...(manage ? { manage } : {}) })
}

export function getConsoleEnv(): ServerEnvDescription {
  return { entries: resolveConsoleEnv()?.entries ?? [] }
}

export async function manageConsoleEnv(request: Request): Promise<Response> {
  const manage = getConsoleSections().includes("env") ? resolveConsoleEnv()?.manage : undefined
  if (!manage) return Response.json({ message: "Env management is unavailable." }, { status: 404, headers: { "cache-control": "no-store" } })
  return manage(request)
}
