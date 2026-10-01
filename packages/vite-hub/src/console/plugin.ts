import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { readColocatedAgentSkills } from "@vite-hub/agent/vite"

import type { AgentInvocationRetentionOptions, AgentInvocationsOptions } from "@vite-hub/agent/server"
import type { ConsoleAgentEntry, ConsoleBuildCatalog } from "./build.ts"
import type { ConsoleAuthMode } from "./internal.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"
import type { ConsoleJournal } from "../storage-config.ts"

import { consoleFixtureRevision, readConsoleFixture } from "./fixture.ts"
import { createConsoleInvocationsIdentity } from "./internal.ts"
import { resolveConsoleProjectNameFromRoot } from "./project.ts"
import { consoleDefinitionSectionIds } from "./runtime/definitions.ts"
import { installConsoleFixtureInvocations } from "./runtime/server/invocations.ts"

// The Console journal on Cloudflare reads the D1 binding from the Worker env. The store creates its table on first use.
function renderConsoleJournal(journal: ConsoleJournal | undefined): string {
  if (!journal) return ""
  if ("databaseUrl" in journal) return `, databaseUrl: ${JSON.stringify(journal.databaseUrl)}`
  return `, d1: { binding: ${JSON.stringify(journal.d1Binding)}, env: async () => (await import("cloudflare:workers")).env }`
}

function renderRetentionLimit(value: number | false | undefined): string {
  if (value === undefined) return "undefined"
  if (Number.isNaN(value)) return "NaN"
  if (value === Number.POSITIVE_INFINITY) return "Infinity"
  if (value === Number.NEGATIVE_INFINITY) return "-Infinity"
  // Keep non-serializable invalid limits subject to runtime validation.
  return JSON.stringify(value) ?? "null"
}

function renderConsoleNitroPlugin(
  projectRoot: string,
  sections: readonly ConsoleSectionId[],
  agents: readonly ConsoleAgentEntry[],
  catalog: ConsoleBuildCatalog,
  blobStores: readonly string[],
  kvStores: readonly string[],
  fixture?: string,
  fixtureSnapshot = fixture ? readConsoleFixture(fixture) : undefined,
  runtimeBinding?: string,
  invoke = false,
  observations?: AgentInvocationsOptions["observations"],
  journal?: ConsoleJournal,
  independentAuth: ConsoleAuthMode | false = false,
  retention?: AgentInvocationRetentionOptions,
): string {
  const definitions = agents.map((agent, index) => {
    const skills = readColocatedAgentSkills(agent.handler)
    const module = `vitehubConsoleAgent${index}`
    const definition = skills
      ? `agentWithColocatedSkills(${module}.default ?? ${module}, ${JSON.stringify(skills)})`
      : module
    return `{ definition: ${definition}, fallbackName: ${JSON.stringify(agent.name)} }`
  }).join(", ")
  const agentsEnabled = sections.includes("agents")
  const blobEnabled = sections.includes("blob")
  const databaseEnabled = sections.includes("databases")
  const kvEnabled = sections.includes("kv")
  const definitionsEnabled = consoleDefinitionSectionIds.some(section => sections.includes(section))
  const schedulesEnabled = sections.includes("schedules")
  // Console invocation also allows manual Schedule runs. Without it, the installed registry stays empty.
  const runnableSchedules = (invoke ? catalog.manualSchedules ?? [] : [])
    .map(schedule => ` [${JSON.stringify(schedule.name)}]: () => import(${JSON.stringify(pathToFileURL(schedule.handler).href)}),`)
    .join("")
    .replace(/,$/, " ")
  const revision = fixtureSnapshot ? consoleFixtureRevision(fixtureSnapshot) : undefined
  const fixtureSource = fixtureSnapshot ? `JSON.parse(${JSON.stringify(JSON.stringify(fixtureSnapshot))})` : undefined
  return [
    `import { installConsoleProjectName, installConsoleSections } from "vite-hub/console/sections"`,
    ...(blobEnabled
      ? [
          `import { installConsoleBlob } from "vite-hub/console/blob"`,
          `import { blob as vitehubConsoleBlob } from "vite-hub/blob"`,
        ]
      : []),
    ...(agentsEnabled
      ? [`import { installConsoleAgentDefinitions, installConsoleFixtureInvocations } from "vite-hub/console/server"`, `import { agentWithColocatedSkills } from "@vite-hub/agent/runtime/workflow"`]
      : []),
    ...(definitionsEnabled ? [`import { installConsoleDefinitions${schedulesEnabled ? ", installConsoleSchedules" : ""} } from "vite-hub/console/definitions"`] : []),
    ...(databaseEnabled
      ? [
          `import { installConsoleDatabase } from "vite-hub/console/database"`,
          `import { databases as vitehubConsoleDatabases } from "vite-hub/database/drizzle"`,
        ]
      : []),
    ...(kvEnabled
      ? [
          `import { installConsoleKV } from "vite-hub/console/kv"`,
          `import { kv as vitehubConsoleKV } from "vite-hub/kv"`,
        ]
      : []),
    ...(sections.includes("env") ? [`import { describeServerEnv } from "#vitehub/env/description"`, `import { installConsoleEnv } from "vite-hub/console/env"`] : []),
    ...agents.map((agent, index) => `import * as vitehubConsoleAgent${index} from ${JSON.stringify(pathToFileURL(agent.handler).href)}`),
    `installConsoleSections(${JSON.stringify(projectRoot)}, ${JSON.stringify(sections)}${independentAuth ? `, ${JSON.stringify(independentAuth)}` : ""})`,
    ...(blobEnabled
      ? [`installConsoleBlob(${JSON.stringify(projectRoot)}, vitehubConsoleBlob, ${JSON.stringify(blobStores)})`]
      : []),
    ...(sections.includes("env") ? [`installConsoleEnv(${JSON.stringify(projectRoot)}, describeServerEnv(), async request => { try { return await (await import("#vitehub/env/server")).manageServerEnv(request) } catch { return Response.json({ message: "Env management is unavailable." }, { status: 503, headers: { "cache-control": "no-store" } }) } })`] : []),
    `installConsoleProjectName(${JSON.stringify(projectRoot)}, ${JSON.stringify(resolveConsoleProjectNameFromRoot(projectRoot))})`,
    ...(definitionsEnabled ? [`installConsoleDefinitions(${JSON.stringify(projectRoot)}, ${JSON.stringify(catalog.definitions)})`] : []),
    ...(schedulesEnabled ? [`installConsoleSchedules(${JSON.stringify(projectRoot)}, {${runnableSchedules}})`] : []),
    ...(databaseEnabled
      ? [`installConsoleDatabase(${JSON.stringify(projectRoot)}, vitehubConsoleDatabases, ${JSON.stringify(catalog.definitions.databases?.map(definition => definition.name) ?? [])})`]
      : []),
    ...(agentsEnabled
      ? fixture
        ? [
            `const vitehubConsoleInvocations = installConsoleFixtureInvocations(${JSON.stringify(projectRoot)}, ${JSON.stringify(fixture)}, ${fixtureSource}, ${JSON.stringify(revision)}, ${JSON.stringify(runtimeBinding)})`,
            `installConsoleAgentDefinitions([${definitions}], { invocations: vitehubConsoleInvocations })`,
          ]
        : [`installConsoleAgentDefinitions([${definitions}], { projectRoot: ${JSON.stringify(projectRoot)}${invoke ? ", invoke: true" : ""}${observations !== undefined ? `, observations: ${JSON.stringify(observations)}` : ""}${renderConsoleJournal(journal)}${retention !== undefined ? `, retention: { maxAgeMs: ${renderRetentionLimit(retention.maxAgeMs)}, maxRecords: ${renderRetentionLimit(retention.maxRecords)} }` : ""} })`]
      : []),
    ...(kvEnabled
      ? [`installConsoleKV(${JSON.stringify(projectRoot)}, vitehubConsoleKV, ${JSON.stringify(kvStores)})`]
      : []),
    "export default function viteHubConsolePlugin() {}",
    "",
  ].join("\n")
}

export async function writeConsoleNitroPlugin(
  file: string,
  projectRoot: string,
  sections: readonly ConsoleSectionId[],
  agents: readonly ConsoleAgentEntry[],
  catalog: ConsoleBuildCatalog,
  blobStores: readonly string[],
  kvStores: readonly string[],
  fixture?: string,
  runtimeBinding?: string,
  invoke = false,
  observations: AgentInvocationsOptions["observations"] = undefined,
  active: () => boolean = () => true,
  journal?: ConsoleJournal,
  independentAuth: ConsoleAuthMode | false = false,
  retention?: AgentInvocationRetentionOptions,
): Promise<string> {
  const snapshot = fixture ? readConsoleFixture(fixture) : undefined
  const identity = createConsoleInvocationsIdentity(
    projectRoot,
    fixture,
    snapshot ? consoleFixtureRevision(snapshot) : undefined,
    runtimeBinding,
  )
  if (!active()) return identity
  const contents = renderConsoleNitroPlugin(projectRoot, sections, agents, catalog, blobStores, kvStores, fixture, snapshot, runtimeBinding, invoke, observations, journal, independentAuth, retention)
  if (await readFile(file, "utf8").catch(() => undefined) !== contents) {
    await mkdir(resolve(file, ".."), { recursive: true })
    await writeFile(file, contents, "utf8")
  }
  if (fixture && snapshot) {
    installConsoleFixtureInvocations(projectRoot, fixture, snapshot, consoleFixtureRevision(snapshot), runtimeBinding)
  }
  return identity
}
