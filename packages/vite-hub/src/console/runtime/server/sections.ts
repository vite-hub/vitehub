import { installConsoleProjectNameScope, installConsoleSectionScope, resolveConsoleProjectName, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleSectionId } from "../sections.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[]): readonly ConsoleSectionId[] {
  return installConsoleSectionScope(projectRoot, sections)
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  return installConsoleProjectNameScope(projectRoot, projectName)
}

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return resolveConsoleSections()
}

export function getConsoleProjectName(): string | undefined {
  return resolveConsoleProjectName()
}
