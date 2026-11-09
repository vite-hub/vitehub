import { resolveConsoleAuth, resolveConsoleBuild, resolveConsoleProjectName, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleSectionId } from "../sections.ts"

// Generated Console output installs its access policy from this entry, next to its sections.
export { consoleConnectionsActor, consoleRealtimeAccess, resolveConsoleAppAuthIdentity } from "./access.ts"
export { createConsoleAppAuthAccess, createConsoleAppAuthPages } from "../../auth-pages.ts"
export type { ConsoleRealtimeAccess, ConsoleRealtimeUser } from "./access.ts"
export { installConsoleAccess, installConsoleBuild, installConsoleDevelopment, installConsoleOrigins, installConsolePageTool, installConsoleProjectName, installConsoleRuntime, installConsoleSections } from "./setup.ts"

export function getConsoleBuild(): string | undefined {
  return resolveConsoleBuild()
}

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return resolveConsoleSections()
}

export function getConsoleAuth(): ConsoleAuthMode | false {
  return resolveConsoleAuth()
}

export function getConsoleProjectName(): string | undefined {
  return resolveConsoleProjectName()
}
