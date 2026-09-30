import { installConsoleProjectNameScope, installConsoleSectionScope, resolveConsoleAuth, resolveConsoleProjectName, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleSectionId } from "../sections.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], independentAuth: ConsoleAuthMode | false = false): readonly ConsoleSectionId[] {
  return installConsoleSectionScope(projectRoot, sections, undefined, independentAuth)
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
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
