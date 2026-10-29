import { allowedConsoleSections, consoleAccessWrites, withConsoleAccess, type ConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest } from "./request.ts"
import { getConsoleContributedSections } from "./definitions.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { getConsoleAuth, getConsoleBuild, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleContributedSection } from "../definitions.ts"
import type { ConsoleRequestEvent } from "./request.ts"

/** The sections that this request may use. The client hides the others. Each route still checks its own section. */
function consoleSectionsHandler(event: ConsoleRequestEvent, access: ConsoleAccess): {
  auth?: true
  /** The build id of the deployed Console. An open Console that loaded another id is outdated. */
  build?: string
  contributions?: readonly ConsoleContributedSection[]
  /** The registered operations that run app code (`console.invoke`) and that this request may run. The pages hide the others. */
  operations?: readonly string[]
  projectName?: string
  /** Sections that the access may only read (`"<section>:read"`). The client hides their write actions. */
  readOnly?: readonly string[]
  /** `console.authorize` limited this request to some sections, so the others may be installed but hidden. */
  scoped?: true
  sections: readonly string[]
} {
  assertConsoleRequest(event)
  const projectName = getConsoleProjectName()
  const sections = allowedConsoleSections(access, getConsoleSections())
  const contributions = getConsoleContributedSections().filter(section => sections.includes(section.id))
  const build = getConsoleBuild()
  const result: { auth?: true, build?: string, contributions?: readonly ConsoleContributedSection[], operations?: readonly string[], projectName?: string, readOnly?: readonly string[], scoped?: true, sections: readonly string[] } = { sections }
  const readOnly = sections.filter(section => !consoleAccessWrites(access, section))
  if (readOnly.length) result.readOnly = readOnly
  if (getConsoleAuth() || access.mode === "auth") result.auth = true
  if (access.sections !== "all") result.scoped = true
  if (contributions.length) result.contributions = contributions
  const operations = consoleOperationRegistry().list()
    .filter(operation => operation.invoke && typeof operation.section === "string" && consoleAccessWrites(access, operation.section))
    .map(operation => operation.name)
  if (operations.length) result.operations = operations
  if (projectName) result.projectName = projectName
  if (build) result.build = build
  return result
}

const guardedHandler: ConsoleAccessRoute<typeof consoleSectionsHandler> = withConsoleAccess(consoleSectionsHandler, { anySection: true })
export default guardedHandler
