import { withConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest } from "./request.ts"
import { getConsoleContributedSections } from "./definitions.ts"
import { getConsoleAuth, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleContributedSection } from "../definitions.ts"
import type { ConsoleRequestEvent } from "./request.ts"
import type { ConsoleAuthMode } from "../../internal.ts"

function consoleSectionsHandler(event: ConsoleRequestEvent): {
  auth?: true
  contributions?: readonly ConsoleContributedSection[]
  projectName?: string
  sections: readonly string[]
} {
  assertConsoleRequest(event)
  const projectName = getConsoleProjectName()
  const sections = getConsoleSections()
  const contributions = getConsoleContributedSections().filter(section => sections.includes(section.id))
  const result: { auth?: true, contributions?: readonly ConsoleContributedSection[], projectName?: string, sections: readonly string[] } = { sections }
  if (getConsoleAuth()) result.auth = true
  if (contributions.length) result.contributions = contributions
  if (projectName) result.projectName = projectName
  return result
}

const guardedHandler: ConsoleAccessRoute<typeof consoleSectionsHandler> = withConsoleAccess(consoleSectionsHandler)
export default guardedHandler
