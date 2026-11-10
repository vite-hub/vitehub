import { installConsoleProjectRoot } from "./project-root.ts"
import { consoleState } from "../../internal.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleSectionId } from "../sections.ts"

// Generated Console output installs its access policy from this entry, next to its sections.
export { consoleConnectionsActor, consoleRealtimeAccess, resolveConsoleAppAuthIdentity } from "./access.ts"
export { installConsoleAccess } from "./access-policy.ts"
export { verifyConsoleJwt } from "./bearer-jwt.ts"
export { createConsoleAppAuthAccess, createConsoleAppAuthPages } from "../../auth-pages.ts"
export { installConsolePageTool } from "./page-tool.ts"
export { installConsoleClient } from "./client-assets.ts"
export { installConsoleOrigins } from "./cors.ts"
export { installConsoleRuntime } from "./runtime.ts"
export type { ConsoleRealtimeAccess, ConsoleRealtimeUser } from "./access.ts"
export { installConsoleDevelopment } from "./development.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], independentAuth: ConsoleAuthMode | false = false): readonly ConsoleSectionId[] {
  const state = consoleState()
  state.auth = independentAuth
  return state.sections = [...new Set(sections)]
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  installConsoleProjectRoot(projectRoot)
  return consoleState().projectName = projectName
}

/**
 * Install the build id of the generated Console output. It changes when the Console catalog or the Console client
 * changes, so an open Console compares it to know that a newer Console is deployed.
 */
export function installConsoleBuild(projectRoot: string, build: string): string {
  return consoleState().build = build
}

export function getConsoleBuild(): string | undefined {
  return consoleState().build
}

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return consoleState().sections ?? []
}

export function getConsoleAuth(): ConsoleAuthMode | false {
  return consoleState().auth ?? false
}

export function getConsoleProjectName(): string | undefined {
  return consoleState().projectName
}
