import { mkdir, readFile, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { discoverWorkflowDefinitions } from "@vite-hub/workflow/vite"

import type { DiscoveredWorkflowDefinition } from "@vite-hub/workflow"
import { consoleDefinitionSectionIds } from "./runtime/definitions.ts"
import type { ConsoleDefinitionCatalog, ConsoleDefinitionField, ConsoleDefinitionSummary } from "./runtime/definitions.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

export const generatedConsolePlugin = ".vitehub/nitro/console/plugin.mjs"

export type ConsoleAgentEntry = { handler: string; name: string }

export interface ConsoleBuildCatalog {
  agents: readonly ConsoleAgentEntry[]
  definitions: ConsoleDefinitionCatalog
}

function relativeDefinitionFile(projectRoot: string, file: string): string {
  return relative(projectRoot, file).replaceAll("\\", "/")
}

function workflowFields(
  projectRoot: string,
  definition: DiscoveredWorkflowDefinition,
): ConsoleDefinitionField[] {
  return [
    ...(definition.agentIdentity
      ? [{ label: "Agent identity", value: definition.agentIdentity }]
      : []),
    ...(definition.steps?.length
      ? [{
          label: "Steps",
          value: definition.steps
            .map(step => relativeDefinitionFile(projectRoot, step))
            .join(", "),
        }]
      : []),
  ]
}

function workflowDefinition(
  projectRoot: string,
  definition: DiscoveredWorkflowDefinition,
): ConsoleDefinitionSummary {
  return {
    fields: workflowFields(projectRoot, definition),
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "workflow",
  }
}

export function discoverConsoleBuildCatalog(options: {
  discoveryRoot: string
  projectRoot: string
  sections: readonly ConsoleSectionId[]
  serverDirs?: string[]
}): ConsoleBuildCatalog {
  const agents = options.sections.includes("agents")
    ? discoverAgentDefinitionEntries(options.discoveryRoot, options.serverDirs)
    : []
  const workflows = options.sections.includes("workflows")
    ? discoverWorkflowDefinitions({
        rootDir: options.discoveryRoot,
        serverDirs: options.serverDirs,
      })
        .filter(definition => definition.source !== "agent-workflow-recovery")
        .map(definition => workflowDefinition(options.projectRoot, definition))
    : []
  return {
    agents,
    definitions: options.sections.includes("workflows") ? { workflows } : {},
  }
}

export function renderConsoleNitroPlugin(options: {
  catalog: ConsoleBuildCatalog
  kvStores: readonly string[]
  projectRoot: string
  sections: readonly ConsoleSectionId[]
}): string {
  const agentsEnabled = options.sections.includes("agents")
  const definitionsEnabled = consoleDefinitionSectionIds.some(section => options.sections.includes(section))
  const kvEnabled = options.sections.includes("kv")
  return [
    `import { installConsoleSections } from "vite-hub/console/sections"`,
    ...(agentsEnabled
      ? [`import { installConsoleAgentDefinitions, installConsoleInvocations } from "vite-hub/console/server"`]
      : []),
    ...(definitionsEnabled
      ? [`import { installConsoleDefinitions } from "vite-hub/console/definitions"`]
      : []),
    ...(kvEnabled
      ? [
          `import { installConsoleKV } from "vite-hub/console/kv"`,
          `import { kv as vitehubConsoleKV } from "vite-hub/kv"`,
        ]
      : []),
    ...options.catalog.agents.map((agent, index) =>
      `import * as vitehubConsoleAgent${index} from ${JSON.stringify(pathToFileURL(agent.handler).href)}`),
    `installConsoleSections(${JSON.stringify(options.projectRoot)}, ${JSON.stringify(options.sections)})`,
    ...(definitionsEnabled
      ? [`installConsoleDefinitions(${JSON.stringify(options.projectRoot)}, ${JSON.stringify(options.catalog.definitions)})`]
      : []),
    ...(agentsEnabled
      ? [
          `const vitehubConsoleInvocations = installConsoleInvocations(${JSON.stringify(options.projectRoot)})`,
          `installConsoleAgentDefinitions([${options.catalog.agents.map((agent, index) => `{ definition: vitehubConsoleAgent${index}, fallbackName: ${JSON.stringify(agent.name)} }`).join(", ")}], vitehubConsoleInvocations)`,
        ]
      : []),
    ...(kvEnabled
      ? [`installConsoleKV(${JSON.stringify(options.projectRoot)}, vitehubConsoleKV, ${JSON.stringify(options.kvStores)})`]
      : []),
    "export default function viteHubConsolePlugin() {}",
    "",
  ].join("\n")
}

export async function writeConsoleNitroPlugin(
  file: string,
  options: Parameters<typeof renderConsoleNitroPlugin>[0],
): Promise<void> {
  const contents = renderConsoleNitroPlugin(options)
  if ((await readFile(file, "utf8").catch(() => undefined)) === contents) return
  await mkdir(resolve(file, ".."), { recursive: true })
  await writeFile(file, contents, "utf8")
}
