import { assertConsoleRequest } from "./request.ts"
import { getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleRequestEvent } from "./request.ts"

export default function consoleSectionsHandler(event: ConsoleRequestEvent): {
  projectName?: string
  sections: readonly string[]
} {
  assertConsoleRequest(event)
  const projectName = getConsoleProjectName()
  return { ...(projectName ? { projectName } : {}), sections: getConsoleSections() }
}
