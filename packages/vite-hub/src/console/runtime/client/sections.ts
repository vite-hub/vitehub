import type { ConsoleSectionId } from "../sections"

import { isConsoleSectionId } from "../sections"
import { requestConsole } from "./request"

export interface ConsoleNavigation {
  projectName?: string
  sections: ConsoleSectionId[]
}

const navigationRequests = new Map<string, Promise<ConsoleNavigation | undefined>>()

function parseConsoleNavigation(value: unknown): ConsoleNavigation {
  // SAFETY: Reading an optional property is safe for every non-null JavaScript value; the property remains unknown until validated below.
  const response = value as { projectName?: unknown, sections?: unknown } | null | undefined
  const sections = Array.isArray(response?.sections) ? response.sections.filter(isConsoleSectionId) : []
  return {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    ...(typeof response?.projectName === "string" && response.projectName.trim()
      ? { projectName: response.projectName.trim() }
      : {}),
    sections,
  }
}

export async function loadConsoleNavigation(base: string): Promise<ConsoleNavigation | undefined> {
  let request = navigationRequests.get(base)
  if (!request) {
    request = requestConsole(base)
      .then(parseConsoleNavigation)
      .catch(() => {
        navigationRequests.delete(base)
        return undefined
      })
    navigationRequests.set(base, request)
  }
  return await request
}

export function createConsoleSectionLoader(base: string): () => Promise<ConsoleSectionId[] | undefined> {
  return async () => (await loadConsoleNavigation(base))?.sections
}
