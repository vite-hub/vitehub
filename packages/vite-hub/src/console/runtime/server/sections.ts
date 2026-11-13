import { consoleState } from "../../internal.ts"

import type { ConsoleSectionId } from "../sections.ts"

// Request-time access checks. Generated output installs setters from `./setup.ts`.
export { consoleRealtimeAccess } from "./access.ts"
export type { ConsoleRealtimeAccess, ConsoleRealtimeUser } from "./access.ts"
export { installConsoleAccess, installConsoleDevelopment, installConsoleProjectName, installConsoleRuntime, installConsoleSections } from "./setup.ts"

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return consoleState().sections ?? []
}

export function getConsoleProjectName(): string | undefined {
  return consoleState().projectName
}
