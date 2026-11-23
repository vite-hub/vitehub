import { consoleState } from "../../internal.ts"

import type { ConsoleProjectBuild } from "./project.ts"
import type { ConsoleSectionId } from "../sections.ts"

// Request-time access checks. Generated output installs setters from `./setup.ts`.
export { consoleRealtimeAccess } from "./access.ts"
export type { ConsoleRealtimeAccess, ConsoleRealtimeUser } from "./access.ts"
export { installConsoleAccess, installConsoleBuild, installConsoleDevelopment, installConsoleProjectName, installConsoleRuntime, installConsoleSections, installConsoleVersion } from "./setup.ts"

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return consoleState().sections ?? []
}

/** Whether the app has the primitive of this section, also when `console.sections` hides the section. */
export function hasConsoleIntegration(section: ConsoleSectionId): boolean {
  const state = consoleState()
  return Boolean(state.sections?.includes(section) || state.hiddenSections?.includes(section))
}

export function getConsoleProjectName(): string | undefined {
  return consoleState().projectName
}

export function getConsoleBuild(): ConsoleProjectBuild | undefined {
  return consoleState().build
}
