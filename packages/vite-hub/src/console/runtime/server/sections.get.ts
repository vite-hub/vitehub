import { assertConsoleRequest } from "./request.ts"
import { getConsoleAuth, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleRequestEvent } from "./request.ts"

export default function consoleSectionsHandler(event: ConsoleRequestEvent): {
  auth?: ConsoleAuthMode
  projectName?: string
  sections: readonly string[]
} {
  assertConsoleRequest(event)
  const projectName = getConsoleProjectName()
  const auth = getConsoleAuth()
  const result: { auth?: ConsoleAuthMode, projectName?: string, sections: readonly string[] } = { sections: getConsoleSections() }
  if (auth) result.auth = auth
  if (projectName) result.projectName = projectName
  return result
}
