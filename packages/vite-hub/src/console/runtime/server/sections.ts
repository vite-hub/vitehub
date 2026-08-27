import { installConsoleSections as installSections, resolveConsoleSections } from "../../internal.ts"

import type { ConsoleSectionId } from "../sections.ts"

export function installConsoleSections(projectRoot: string, sections: readonly ConsoleSectionId[]): readonly ConsoleSectionId[] {
  return installSections(projectRoot, sections)
}

export function getConsoleSections(): readonly ConsoleSectionId[] {
  return resolveConsoleSections()
}
