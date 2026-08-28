import type { ConsoleSectionId } from "../sections"

import { isConsoleSectionId } from "../sections"
import { requestConsole } from "./request"

export function createConsoleSectionLoader(base: string): () => Promise<ConsoleSectionId[] | undefined> {
  let installedSections: Promise<ConsoleSectionId[] | undefined> | undefined

  return async () => {
    if (!installedSections) {
      installedSections = requestConsole(base)
        .then(value => value && typeof value === "object" && "sections" in value && Array.isArray(value.sections)
          ? value.sections.filter(isConsoleSectionId)
          : [])
        .catch(() => {
          installedSections = undefined
          return undefined
        })
    }
    return await installedSections
  }
}
