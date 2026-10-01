import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { discoverWorkflowDefinitions } from "./discovery.ts"

import type { ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { DiscoveredWorkflowDefinition } from "./types.ts"

export interface WorkflowInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

function summarizeWorkflowDefinition(projectRoot: string, definition: DiscoveredWorkflowDefinition): ViteHubDefinitionSummary {
  return {
    fields: [
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
    ],
    file: relativeDefinitionFile(projectRoot, definition.handler),
    name: definition.name,
    source: definition.source || "workflow",
  }
}

/** Lists user-facing Workflow Definitions. Generated Agent recovery Workflows are internal and stay hidden. */
export function inspectWorkflowDefinitions(options: WorkflowInspectionOptions): ViteHubDefinitionSummary[] {
  return discoverWorkflowDefinitions({ rootDir: options.rootDir, serverDirs: options.serverDirs })
    .filter(definition => definition.source !== "agent-workflow-recovery")
    .map(definition => summarizeWorkflowDefinition(options.projectRoot, definition))
}

/** Console section that lists discovered Workflow Definitions. `vitehub inspect definitions` reads the same data. */
export const workflowConsoleSection: ViteHubConsoleSectionContribution<WorkflowInspectionOptions> = {
  description: "Inspect discovered Workflow Definitions and their source metadata.",
  icon: "i-ph-git-branch-light",
  id: "workflows",
  label: "Workflows",
  read: inspectWorkflowDefinitions,
  view: {
    kind: "definition-catalog",
    notice: "Workflow run history is not exposed by ViteHub's provider-independent Workflow contract yet.",
  },
}
