import { allowedConsoleSections, consoleAccessWrites, type ConsoleAccess } from "./access.ts"
import { getConsoleContributedSections } from "./definitions.ts"
import { consoleSetupRoute } from "./development.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { getConsoleAuth, getConsoleBuild, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleContributedSection } from "../definitions.ts"

interface ConsoleSectionsResponse {
  auth?: true | "cloudflare-access"
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
  /** The route of the dev Setup endpoints, only on a development server. */
  setup?: string
}

/** The sections that this access may use. Each operation still checks its own section. */
export function listConsoleSections(access: ConsoleAccess): ConsoleSectionsResponse {
  const projectName = getConsoleProjectName()
  const sections = allowedConsoleSections(access, getConsoleSections())
  const contributions = getConsoleContributedSections().filter(section => sections.includes(section.id))
  const build = getConsoleBuild()
  const result: ConsoleSectionsResponse = { sections }
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
  if (build) result.build = build
  const setup = sections.includes("setup") ? consoleSetupRoute() : undefined
  if (setup) result.setup = setup
  return result
}
