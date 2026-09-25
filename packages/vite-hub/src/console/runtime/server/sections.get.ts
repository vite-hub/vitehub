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
  return { ...(getConsoleAuth() ? { auth: true as const } : {}), ...(projectName ? { projectName } : {}), sections: getConsoleSections() }
}
