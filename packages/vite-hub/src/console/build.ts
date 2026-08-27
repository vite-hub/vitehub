import { mkdir, readFile, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { discoverDatabaseDefinitions } from "@vite-hub/database/config"
import { discoverQueueDefinitions } from "@vite-hub/queue/vite"
import { discoverRateLimitDeclarations } from "@vite-hub/rate-limit/vite"
import { discoverScheduleDefinitions, readScheduleDefinitionCrons } from "@vite-hub/schedule/vite"
import { discoverSandboxDefinitions } from "@vite-hub/sandbox/vite"
import { discoverWorkflowDefinitions } from "@vite-hub/workflow/vite"
import { discoverViteWorkspaceDefinitions } from "@vite-hub/workspace/vite"

import type { DiscoveredDatabaseDefinition } from "@vite-hub/database"
import type { DiscoveredQueueDefinition } from "@vite-hub/queue"
import type { RateLimitDeclaration } from "@vite-hub/rate-limit"
import type { DiscoveredScheduleDefinition } from "@vite-hub/schedule"
import type { DiscoveredSandboxDefinition } from "@vite-hub/sandbox/vite"
import type { DiscoveredWorkflowDefinition } from "@vite-hub/workflow"
import type { DiscoveredWorkspaceDefinition } from "@vite-hub/workspace/vite"
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

function queueDefinition(
  projectRoot: string,
  definition: DiscoveredQueueDefinition,
): ConsoleDefinitionSummary {
  return {
    fields: [],
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "queue",
  }
}

function rateLimitDefinition(
  projectRoot: string,
  declaration: RateLimitDeclaration,
): ConsoleDefinitionSummary {
  return {
    fields: [
      { label: "Limit", value: String(declaration.policy.limit) },
      { label: "Window", value: declaration.policy.window },
      { label: "Enforcement", value: declaration.policy.enforcement === "strict" ? "Strict" : "Best effort" },
      { label: "Provider failure", value: declaration.policy.failure === "allow" ? "Allow" : "Deny" },
      { label: "Source location", value: `${declaration.source.line}:${declaration.source.column}` },
    ],
    file: relativeDefinitionFile(projectRoot, declaration.source.file),
    name: declaration.name,
    source: "require-rate-limit",
  }
}

function workspaceDefinition(
  projectRoot: string,
  definition: DiscoveredWorkspaceDefinition,
): ConsoleDefinitionSummary {
  return {
    fields: [
      { label: "Kind", value: definition.source === "server-agent-workspaces" ? "Agent workspace" : "Workspace Definition" },
      ...(definition.sourceRootDir
        ? [{ label: "Source root", value: relativeDefinitionFile(projectRoot, definition.sourceRootDir) }]
        : []),
    ],
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "workspace",
  }
}

function sandboxDefinition(projectRoot: string, definition: DiscoveredSandboxDefinition): ConsoleDefinitionSummary {
  return {
    fields: [{ label: "Kind", value: definition.kind === "package-entry" ? "Package entry" : "Definition" }],
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source,
  }
}

function databaseDefinition(
  projectRoot: string,
  definition: DiscoveredDatabaseDefinition,
): ConsoleDefinitionSummary {
  return {
    fields: [
      { label: "Mode", value: definition.mode === "default" ? "Default" : "Named" },
      { label: "Tables", value: definition.tableNames.length ? definition.tableNames.join(", ") : "None discovered" },
    ],
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "database",
  }
}

function scheduleDefinition(
  projectRoot: string,
  definition: DiscoveredScheduleDefinition,
  crons: ReadonlyMap<string, string>,
): ConsoleDefinitionSummary {
  const cron = crons.get(definition.name)
  const fields: ConsoleDefinitionField[] = [
    { label: "Kind", value: definition.runtimeOnly ? "Runtime target" : "Static schedule" },
  ]
  if (cron) {
    fields.push(
      { label: "Cron", value: cron },
      { label: "Time zone", value: "UTC" },
    )
  }
  if (definition.allowRuntimeSchedules) {
    fields.push({ label: "Runtime schedules", value: "Allowed" })
  }
  return {
    fields,
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "schedule",
  }
}

export async function discoverConsoleBuildCatalog(options: {
  discoveryRoot: string
  projectRoot: string
  sections: readonly ConsoleSectionId[]
  serverDirs?: string[]
}): Promise<ConsoleBuildCatalog> {
  const agents = options.sections.includes("agents")
    ? discoverAgentDefinitionEntries(options.discoveryRoot, options.serverDirs)
    : []
  const databases = options.sections.includes("databases")
    ? discoverDatabaseDefinitions(options.discoveryRoot, {
        serverDirs: options.serverDirs,
      }).map(definition => databaseDefinition(options.projectRoot, definition))
    : []
  const workflows = options.sections.includes("workflows")
    ? discoverWorkflowDefinitions({
        rootDir: options.discoveryRoot,
        serverDirs: options.serverDirs,
      })
        .filter(definition => definition.source !== "agent-workflow-recovery")
        .map(definition => workflowDefinition(options.projectRoot, definition))
    : []
  const workspaces = options.sections.includes("workspaces")
    ? discoverViteWorkspaceDefinitions(options.discoveryRoot, {
        serverDirs: options.serverDirs,
        serverRootDir: options.projectRoot,
      }).map(definition => workspaceDefinition(options.projectRoot, definition))
    : []
  const sandboxes = options.sections.includes("sandboxes")
    ? discoverSandboxDefinitions({ rootDir: options.discoveryRoot, scanDirs: options.serverDirs })
        .map(definition => sandboxDefinition(options.projectRoot, definition))
    : []
  const rateLimits = options.sections.includes("rate-limits")
    ? discoverRateLimitDeclarations({
        rootDir: options.discoveryRoot,
        scanDirs: options.serverDirs,
      }).map(declaration => rateLimitDefinition(options.projectRoot, declaration))
    : []
  const queues = options.sections.includes("queues")
    ? discoverQueueDefinitions({
        rootDir: options.discoveryRoot,
        serverDirs: options.serverDirs,
      }).map(definition => queueDefinition(options.projectRoot, definition))
    : []
  const discoveredSchedules = options.sections.includes("schedules")
    ? discoverScheduleDefinitions({
        rootDir: options.discoveryRoot,
        serverDirs: options.serverDirs,
      })
    : []
  const scheduleCrons = discoveredSchedules.length > 0
    ? await readScheduleDefinitionCrons(discoveredSchedules)
    : new Map<string, string>()
  const schedules = discoveredSchedules
    .map(definition => scheduleDefinition(options.projectRoot, definition, scheduleCrons))
  const definitions: ConsoleDefinitionCatalog = {}
  if (options.sections.includes("databases")) definitions.databases = databases
  if (options.sections.includes("rate-limits")) definitions["rate-limits"] = rateLimits
  if (options.sections.includes("sandboxes")) definitions.sandboxes = sandboxes
  if (options.sections.includes("workspaces")) definitions.workspaces = workspaces
  if (options.sections.includes("workflows")) definitions.workflows = workflows
  if (options.sections.includes("queues")) definitions.queues = queues
  if (options.sections.includes("schedules")) definitions.schedules = schedules
  return {
    agents,
    definitions,
  }
}

export function renderConsoleNitroPlugin(options: {
  blobStores: readonly string[]
  catalog: ConsoleBuildCatalog
  kvStores: readonly string[]
  projectRoot: string
  sections: readonly ConsoleSectionId[]
}): string {
  const agentsEnabled = options.sections.includes("agents")
  const blobEnabled = options.sections.includes("blob")
  const definitionsEnabled = consoleDefinitionSectionIds.some(section => options.sections.includes(section))
  const kvEnabled = options.sections.includes("kv")
  return [
    `import { ${[
      "installConsoleSections",
      ...(blobEnabled ? ["installConsoleBlob"] : []),
      ...(agentsEnabled ? ["installConsoleAgentDefinitions", "installConsoleInvocations"] : []),
      ...(definitionsEnabled ? ["installConsoleDefinitions"] : []),
      ...(kvEnabled ? ["installConsoleKV"] : []),
    ].join(", ")} } from "vite-hub/console/server"`,
    ...(blobEnabled ? [`import { blob as vitehubConsoleBlob } from "vite-hub/blob"`] : []),
    ...(kvEnabled ? [`import { kv as vitehubConsoleKV } from "vite-hub/kv"`] : []),
    ...options.catalog.agents.map((agent, index) =>
      `import * as vitehubConsoleAgent${index} from ${JSON.stringify(pathToFileURL(agent.handler).href)}`),
    `installConsoleSections(${JSON.stringify(options.projectRoot)}, ${JSON.stringify(options.sections)})`,
    ...(blobEnabled
      ? [`installConsoleBlob(${JSON.stringify(options.projectRoot)}, vitehubConsoleBlob, ${JSON.stringify(options.blobStores)})`]
      : []),
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
