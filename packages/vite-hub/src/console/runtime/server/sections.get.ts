import { allowedConsoleSections, consoleAccessWrites, withConsoleAccess, type ConsoleAccess, type ConsoleAccessRoute } from "./access.ts"
import { assertConsoleRequest } from "./request.ts"
import { getConsoleContributedSections } from "./definitions.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { getConsoleAuth, getConsoleBuild, getConsoleProjectName, getConsoleSections } from "./sections.ts"

import type { ConsoleContributedSection } from "../definitions.ts"
import type { ConsoleRequestEvent } from "./request.ts"

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

/** The sections that this request may use. The client hides the others. Each route still checks its own section. */
async function consoleSectionsHandler(event: ConsoleRequestEvent, access: ConsoleAccess): Promise<{
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
}> {
  assertConsoleRequest(event)
  const projectName = getConsoleProjectName()
  const allowed = allowedConsoleSections(access, getConsoleSections())
  const empty = await emptySections(allowed)
  const sections = allowed.filter(section => !empty.has(section))
  const contributions = getConsoleContributedSections().filter(section => sections.includes(section.id))
  const build = getConsoleBuild()
  const result: { auth?: true | "cloudflare-access", build?: string, contributions?: readonly ConsoleContributedSection[], operations?: readonly string[], projectName?: string, readOnly?: readonly string[], scoped?: true, sections: readonly string[] } = { sections }
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
  return result
}

const guardedHandler: ConsoleAccessRoute<typeof consoleSectionsHandler> = withConsoleAccess(consoleSectionsHandler, { anySection: true })
export default guardedHandler
