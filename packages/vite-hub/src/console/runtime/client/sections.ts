import type { ConsoleSectionId } from "../sections"

import { isConsoleSectionId } from "../sections"
import { requestConsole } from "./request"

function parseConsoleSections(value: unknown): ConsoleSectionId[] {
  // SAFETY: Reading an optional property is safe for every non-null JavaScript value; the property remains unknown until validated below.
  const sections = (value as { sections?: unknown } | null | undefined)?.sections
  return Array.isArray(sections) ? sections.filter(isConsoleSectionId) : []
}

export function createConsoleSectionLoader(base: string): () => Promise<ConsoleSectionId[] | undefined> {
  let installedSections: Promise<ConsoleSectionId[] | undefined> | undefined

  return async () => {
    if (!installedSections) {
      installedSections = requestConsole(base)
        .then(parseConsoleSections)
        .catch(() => {
          installedSections = undefined
          return undefined
        })
    }
    return await installedSections
  }
}
