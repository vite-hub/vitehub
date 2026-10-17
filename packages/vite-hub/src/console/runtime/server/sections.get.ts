import { allowedConsoleSections, withConsoleAccess, type ConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest } from "./request.ts"
import { getConsoleContributedSections } from "./definitions.ts"
import { getConsoleAuth, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleContributedSection } from "../definitions.ts"
import type { ConsoleRequestEvent } from "./request.ts"

/** The sections that this request may use. The client hides the others. Each route still checks its own section. */
function consoleSectionsHandler(event: ConsoleRequestEvent, access: ConsoleAccess): {
  auth?: true
  contributions?: readonly ConsoleContributedSection[]
  projectName?: string
  /** `console.authorize` limited this request to some sections, so the others may be installed but hidden. */
  scoped?: true
  sections: readonly string[]
} {
  assertConsoleRequest(event)
  const projectName = getConsoleProjectName()
  const sections = allowedConsoleSections(access, getConsoleSections())
  const contributions = getConsoleContributedSections().filter(section => sections.includes(section.id))
  const result: { auth?: true, contributions?: readonly ConsoleContributedSection[], projectName?: string, scoped?: true, sections: readonly string[] } = { sections }
  if (getConsoleAuth()) result.auth = true
  if (access.sections !== "all") result.scoped = true
  if (contributions.length) result.contributions = contributions
  if (projectName) result.projectName = projectName
  return result
}

const guardedHandler: ConsoleAccessRoute<typeof consoleSectionsHandler> = withConsoleAccess(consoleSectionsHandler, { anySection: true })
export default guardedHandler
