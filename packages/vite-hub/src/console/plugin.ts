import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import type { AgentInvocationsOptions } from "@vite-hub/agent/server"
import type { ConsoleAgentEntry, ConsoleBuildCatalog } from "./build.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

import { consoleFixtureRevision, readConsoleFixture } from "./fixture.ts"
import { createConsoleInvocationsIdentity } from "./internal.ts"
import { resolveConsoleProjectNameFromRoot } from "./project.ts"
import { consoleDefinitionSectionIds } from "./runtime/definitions.ts"
import { installConsoleFixtureInvocations } from "./runtime/server/invocations.ts"

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
): string {
  const agentsEnabled = sections.includes("agents")
  const blobEnabled = sections.includes("blob")
  const databaseEnabled = sections.includes("databases")
  const kvEnabled = sections.includes("kv")
  const definitionsEnabled = consoleDefinitionSectionIds.some(section => sections.includes(section))
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
      ? [`import { installConsoleAgentDefinitions, installConsoleFixtureInvocations } from "vite-hub/console/server"`]
      : []),
    ...(definitionsEnabled ? [`import { installConsoleDefinitions } from "vite-hub/console/definitions"`] : []),
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
    ...agents.map((agent, index) => `import * as vitehubConsoleAgent${index} from ${JSON.stringify(pathToFileURL(agent.handler).href)}`),
    `installConsoleSections(${JSON.stringify(projectRoot)}, ${JSON.stringify(sections)})`,
    ...(blobEnabled
      ? [`installConsoleBlob(${JSON.stringify(projectRoot)}, vitehubConsoleBlob, ${JSON.stringify(blobStores)})`]
      : []),
    `installConsoleProjectName(${JSON.stringify(projectRoot)}, ${JSON.stringify(resolveConsoleProjectNameFromRoot(projectRoot))})`,
    ...(definitionsEnabled ? [`installConsoleDefinitions(${JSON.stringify(projectRoot)}, ${JSON.stringify(catalog.definitions)})`] : []),
    ...(databaseEnabled
      ? [`installConsoleDatabase(${JSON.stringify(projectRoot)}, vitehubConsoleDatabases, ${JSON.stringify(catalog.definitions.databases?.map(definition => definition.name) ?? [])})`]
      : []),
    ...(agentsEnabled
      ? fixture
        ? [
            `const vitehubConsoleInvocations = installConsoleFixtureInvocations(${JSON.stringify(projectRoot)}, ${JSON.stringify(fixture)}, ${fixtureSource}, ${JSON.stringify(revision)}, ${JSON.stringify(runtimeBinding)})`,
            `installConsoleAgentDefinitions([${agents.map((agent, index) => `{ definition: vitehubConsoleAgent${index}, fallbackName: ${JSON.stringify(agent.name)} }`).join(", ")}], { invocations: vitehubConsoleInvocations })`,
          ]
        : [`installConsoleAgentDefinitions([${agents.map((agent, index) => `{ definition: vitehubConsoleAgent${index}, fallbackName: ${JSON.stringify(agent.name)} }`).join(", ")}], { projectRoot: ${JSON.stringify(projectRoot)}${invoke ? ", invoke: true" : ""}${observations !== undefined ? `, observations: ${JSON.stringify(observations)}` : ""} })`]
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
): Promise<string> {
  const snapshot = fixture ? readConsoleFixture(fixture) : undefined
  const identity = createConsoleInvocationsIdentity(
    projectRoot,
    fixture,
    snapshot ? consoleFixtureRevision(snapshot) : undefined,
    runtimeBinding,
  )
  if (!active()) return identity
  const contents = renderConsoleNitroPlugin(projectRoot, sections, agents, catalog, blobStores, kvStores, fixture, snapshot, runtimeBinding, invoke, observations)
  if (await readFile(file, "utf8").catch(() => undefined) !== contents) {
    await mkdir(resolve(file, ".."), { recursive: true })
    await writeFile(file, contents, "utf8")
  }
  if (fixture && snapshot) {
    installConsoleFixtureInvocations(projectRoot, fixture, snapshot, consoleFixtureRevision(snapshot), runtimeBinding)
  }
  return identity
}
