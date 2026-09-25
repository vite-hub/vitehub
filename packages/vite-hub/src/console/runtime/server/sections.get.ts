import { assertConsoleRequest } from "./request.ts"
import { getConsoleAuth, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleRequestEvent } from "./request.ts"

export default function consoleSectionsHandler(event: ConsoleRequestEvent): {
  auth?: true
  projectName?: string
  sections: readonly string[]
} {
  assertConsoleRequest(event)
  const projectName = getConsoleProjectName()
  const result: { auth?: true, projectName?: string, sections: readonly string[] } = { sections: getConsoleSections() }
  if (getConsoleAuth()) result.auth = true
  if (projectName) result.projectName = projectName
  return result
}
