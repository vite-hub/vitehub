import { allowedConsoleSections, consoleAccessWrites, type ConsoleAccess } from "./access.ts"
import { getConsoleContributedSections } from "./definitions.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { getConsoleAuth, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleContributedSection } from "../definitions.ts"

/** The sections that this access may use. The client hides the others. Each operation still checks its own section. */
export function listConsoleSections(access: ConsoleAccess): {
  auth?: true | "cloudflare-access"
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
  const projectName = getConsoleProjectName()
  const sections = allowedConsoleSections(access, getConsoleSections())
  const contributions = getConsoleContributedSections().filter(section => sections.includes(section.id))
  const result: { auth?: true | "cloudflare-access", contributions?: readonly ConsoleContributedSection[], operations?: readonly string[], projectName?: string, readOnly?: readonly string[], scoped?: true, sections: readonly string[] } = { sections }
  const readOnly = sections.filter(section => !consoleAccessWrites(access, section))
  if (readOnly.length) result.readOnly = readOnly
  const auth = getConsoleAuth()
  if (auth) result.auth = auth
  else if (access.mode === "auth") result.auth = true
  if (access.sections !== "all") result.scoped = true
  if (contributions.length) result.contributions = contributions
  const operations = consoleOperationRegistry().list()
    .filter(operation => operation.invoke && typeof operation.section === "string" && consoleAccessWrites(access, operation.section))
    .map(operation => operation.name)
  if (operations.length) result.operations = operations
  if (projectName) result.projectName = projectName
  return result
}
