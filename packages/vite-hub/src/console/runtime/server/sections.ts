import { installConsoleBuildScope, installConsoleProjectNameScope, installConsoleSectionScope, resolveConsoleAuth, resolveConsoleBuild, resolveConsoleProjectName, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleSectionId } from "../sections.ts"

// Generated Console output installs its access policy from this entry, next to its sections.
export { consoleConnectionsActor, consoleRealtimeAccess, installConsoleAccess } from "./access.ts"
export { installConsolePageTool } from "./page-tool.ts"
export type { ConsoleRealtimeAccess, ConsoleRealtimeUser } from "./access.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], independentAuth: ConsoleAuthMode | false = false): readonly ConsoleSectionId[] {
  return installConsoleSectionScope(projectRoot, sections, undefined, independentAuth)
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  return installConsoleProjectNameScope(projectRoot, projectName)
}

/**
 * Install the build id of the generated Console output. It changes when the Console catalog or the Console client
 * changes, so an open Console compares it to know that a newer Console is deployed.
 */
export function installConsoleBuild(projectRoot: string, build: string): string {
  return installConsoleBuildScope(projectRoot, build)
}

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
