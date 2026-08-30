import { relative } from "node:path"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { discoverWorkflowDefinitions } from "@vite-hub/workflow/vite"

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

export function discoverConsoleBuildCatalog(options: {
  discoveryRoot: string
  projectRoot: string
  sections: readonly ConsoleSectionId[]
  serverDirs?: string[]
  workflowDiscoveryRoot?: string
}): ConsoleBuildCatalog {
  const agents = options.sections.includes("agents")
    ? discoverAgentDefinitionEntries(options.discoveryRoot, options.serverDirs)
    : []
  const workflows = options.sections.includes("workflows")
    ? discoverWorkflowDefinitions({
        rootDir: options.workflowDiscoveryRoot ?? options.discoveryRoot,
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
