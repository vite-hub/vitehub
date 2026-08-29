import { installConsoleSectionScope, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleSectionId } from "../sections.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[]): readonly ConsoleSectionId[] {
  return installConsoleSectionScope(projectRoot, sections)
}

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return resolveConsoleSections()
}
