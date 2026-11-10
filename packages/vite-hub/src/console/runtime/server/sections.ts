import { installConsoleProjectRoot } from "./project-root.ts"
import { installConsoleProjectNameScope, installConsoleSectionScope, resolveConsoleAuth, resolveConsoleProjectName, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleSectionId } from "../sections.ts"

// Generated Console output installs its access policy from this entry, next to its sections.
export { consoleConnectionsActor, consoleRealtimeAccess, resolveConsoleAppAuthIdentity } from "./access.ts"
export { installConsoleAccess } from "./access-policy.ts"
export { verifyConsoleJwt } from "./bearer-jwt.ts"
export { createConsoleAppAuthAccess, createConsoleAppAuthPages } from "../../auth-pages.ts"
export { installConsoleOrigins } from "./cors.ts"
export { installConsoleRuntime } from "./runtime.ts"
export type { ConsoleRealtimeAccess, ConsoleRealtimeUser } from "./access.ts"
export { installConsoleDevelopment } from "./development.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], independentAuth: ConsoleAuthMode | false = false): readonly ConsoleSectionId[] {
  return installConsoleSectionScope(projectRoot, sections, undefined, independentAuth)
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  installConsoleProjectRoot(projectRoot)
  return installConsoleProjectNameScope(projectRoot, projectName)
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
