import { installConsoleProjectNameScope, installConsoleSectionScope, resolveConsoleAuth, resolveConsoleProjectName, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleSectionId } from "../sections.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[], independentAuth = false): readonly ConsoleSectionId[] {
  return installConsoleSectionScope(projectRoot, sections, undefined, independentAuth)
}

export function installConsoleProjectName(projectRoot: string, projectName: string): string {
  return installConsoleProjectNameScope(projectRoot, projectName)
}

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return resolveConsoleSections()
}

export function getConsoleAuth(): boolean {
  return resolveConsoleAuth()
}

export function getConsoleProjectName(): string | undefined {
  return resolveConsoleProjectName()
}
