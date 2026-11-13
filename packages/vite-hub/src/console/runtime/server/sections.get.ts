import { allowedConsoleSections, consoleAccessWrites, type ConsoleAccess } from "./access.ts"
import { getConsoleContributedSections } from "./definitions.ts"
import { consoleState } from "../../internal.ts"
import { consoleSetupRoute } from "./development.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleContributedSection } from "../definitions.ts"

/** Whether an Agent field such as `channels` lists at least one entry, as an array or a record. */
function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return value instanceof Object && Object.keys(value).length > 0
}

/**
 * Sections that have nothing to show: Skills without a bundled Skill, Channels without a Channel, and Env without a
 * declaration. The navigation leaves them out. Their operations stay installed, so the CLI still reads them.
 */
async function emptySections(sections: readonly string[]): Promise<Set<string>> {
  const empty = new Set<string>()
  if (sections.includes("env") && !(await import("./env.ts")).getConsoleEnv().entries.length) empty.add("env")
  if (import.meta.viteHubConsoleAgents !== false && (sections.includes("skills") || sections.includes("channels"))) {
    const { getConsoleAgentDefinition, getConsoleAgents } = await import("./agents.ts")
    const definitions = getConsoleAgents().map(name => getConsoleAgentDefinition(name, "inspect"))
    if (sections.includes("channels") && !definitions.some(definition => hasEntries(definition?.channels))) empty.add("channels")
    if (sections.includes("skills")) {
      const { inspectAgentSkillFiles } = await import("@vite-hub/agent/server/internal")
      if (!definitions.some(definition => definition && inspectAgentSkillFiles(definition).length)) empty.add("skills")
    }
  }
  return empty
}

interface ConsoleSectionsResponse {
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

/** The sections that this access may use. The client hides the others. Each operation still checks its own section. */
export async function listConsoleSections(access: ConsoleAccess): Promise<ConsoleSectionsResponse> {
  const projectName = getConsoleProjectName()
  const allowed = allowedConsoleSections(access, consoleState().navigationSections ?? getConsoleSections())
  const empty = await emptySections(allowed)
  const sections = allowed.filter(section => !empty.has(section))
  const contributions = getConsoleContributedSections().filter(section => sections.includes(section.id))
  const result: ConsoleSectionsResponse = { sections }
  const readOnly = sections.filter(section => !consoleAccessWrites(access, section))
  if (readOnly.length) result.readOnly = readOnly
  if (access.sections !== "all") result.scoped = true
  if (contributions.length) result.contributions = contributions
  const operations = consoleOperationRegistry().list()
    .filter(operation => operation.invoke && typeof operation.section === "string" && consoleAccessWrites(access, operation.section))
    .map(operation => operation.name)
  if (operations.length) result.operations = operations
  if (projectName) result.projectName = projectName
  const setup = sections.includes("setup") ? consoleSetupRoute() : undefined
  if (setup) result.setup = setup
  return result
}
