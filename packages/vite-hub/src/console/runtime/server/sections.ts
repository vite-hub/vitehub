import { resolveConsoleAuth, resolveConsoleProjectName, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleSectionId } from "../sections.ts"

// Request-time access checks and sign-in pages. Generated output installs setters from `./setup.ts`.
export { consoleConnectionsActor, consoleRealtimeAccess, resolveConsoleAppAuthIdentity } from "./access.ts"
export { verifyConsoleJwt } from "./bearer-jwt.ts"
export { createConsoleAppAuthAccess, createConsoleAppAuthPages } from "../../auth-pages.ts"
export type { ConsoleRealtimeAccess, ConsoleRealtimeUser } from "./access.ts"
export { installConsoleAccess, installConsoleDevelopment, installConsoleOrigins, installConsoleProjectName, installConsoleRuntime, installConsoleSections } from "./setup.ts"

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return resolveConsoleSections()
}

export function getConsoleAuth(): ConsoleAuthMode | false {
  return resolveConsoleAuth()
}

export function getConsoleProjectName(): string | undefined {
  return resolveConsoleProjectName()
}
