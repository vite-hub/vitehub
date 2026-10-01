import { assertConsoleRequest } from "./request.ts"
import { getConsoleContributedSections } from "./definitions.ts"
import { getConsoleAuth, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleAuthMode } from "../../internal.ts"
import type { ConsoleContributedSection } from "../definitions.ts"
import type { ConsoleRequestEvent } from "./request.ts"

export default function consoleSectionsHandler(event: ConsoleRequestEvent): {
  auth?: ConsoleAuthMode
  contributions?: readonly ConsoleContributedSection[]
  projectName?: string
  sections: readonly string[]
} {
  assertConsoleRequest(event)
  const projectName = getConsoleProjectName()
  const sections = getConsoleSections()
  const contributions = getConsoleContributedSections().filter(section => sections.includes(section.id))
  const result: { auth?: ConsoleAuthMode, contributions?: readonly ConsoleContributedSection[], projectName?: string, sections: readonly string[] } = { sections }
  const auth = getConsoleAuth()
  if (auth) result.auth = auth
  if (contributions.length) result.contributions = contributions
  if (projectName) result.projectName = projectName
  return result
}
