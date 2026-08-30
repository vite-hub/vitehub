import { relative } from "node:path"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { discoverDatabaseDefinitions } from "@vite-hub/database/config"
import { discoverQueueDefinitions } from "@vite-hub/queue/vite"
import { discoverScheduleDefinitions, readScheduleDefinitionCrons } from "@vite-hub/schedule/vite"
import { discoverWorkflowDefinitions } from "@vite-hub/workflow/vite"

import type { DiscoveredDatabaseDefinition } from "@vite-hub/database"
import type { DiscoveredQueueDefinition } from "@vite-hub/queue"
import type { DiscoveredScheduleDefinition } from "@vite-hub/schedule"
import type { DiscoveredWorkflowDefinition } from "@vite-hub/workflow"
import type { ConsoleDefinitionCatalog, ConsoleDefinitionField, ConsoleDefinitionSummary } from "./runtime/definitions.ts"
import type { ConsoleSectionId } from "./runtime/sections.ts"

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
  queueDiscoveryRoot?: string
  sections: readonly ConsoleSectionId[]
  serverDirs?: string[]
  workflowDiscoveryRoot?: string
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
        rootDir: options.workflowDiscoveryRoot ?? options.discoveryRoot,
        serverDirs: options.serverDirs,
      })
        .filter(definition => definition.source !== "agent-workflow-recovery")
        .map(definition => workflowDefinition(options.projectRoot, definition))
    : []
  const queues = options.sections.includes("queues")
    ? discoverQueueDefinitions({
        rootDir: options.queueDiscoveryRoot ?? options.discoveryRoot,
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
  if (options.sections.includes("workflows")) definitions.workflows = workflows
  if (options.sections.includes("queues")) definitions.queues = queues
  if (options.sections.includes("schedules")) definitions.schedules = schedules
  return {
    agents,
    definitions,
  }
}
