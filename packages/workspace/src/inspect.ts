import { isAbsolute } from "node:path"

import { relativeDefinitionFile } from "@vite-hub/internal/inspect"

import { collectWorkspaceContributions } from "./build/contributions.ts"
import { contributedWorkspaceSource, discoverViteWorkspaceDefinitions } from "./build/discovery.ts"

import type { ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"
import type { DiscoveredWorkspaceDefinition } from "./build/discovery.ts"

export interface WorkspaceInspectionOptions {
  /** Vite plugins that can contribute Workspace Definitions through `vitehub.workspaces`. */
  plugins?: readonly unknown[]
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
  serverRootDir: string
}

function workspaceDefinitionKind(definition: DiscoveredWorkspaceDefinition): string {
  if (definition.source === "server-agent-workspaces") return "Agent workspace"
  if (definition.source === contributedWorkspaceSource) return "Contributed Workspace Definition"
  return "Workspace Definition"
}

/** Lists Workspace Definitions, Agent workspaces, and contributed Workspaces as serializable inspection summaries. */
export async function inspectWorkspaceDefinitions(options: WorkspaceInspectionOptions): Promise<ViteHubDefinitionSummary[]> {
  const contributions = await collectWorkspaceContributions(options.plugins, {
    projectRoot: options.projectRoot,
    root: options.rootDir,
    serverDirs: options.serverDirs,
  })
  return discoverViteWorkspaceDefinitions(options.rootDir, {
    contributions,
    serverDirs: options.serverDirs,
    serverRootDir: options.serverRootDir,
  }).map(definition => ({
    fields: [
      { label: "Kind", value: workspaceDefinitionKind(definition) },
      ...(definition.contributor ? [{ label: "Contributed by", value: definition.contributor }] : []),
      ...(definition.export ? [{ label: "Export", value: definition.export }] : []),
      ...(definition.reason ? [{ label: "Reason", value: definition.reason }] : []),
      ...(definition.sourceRootDir
        ? [{ label: "Source root", value: relativeDefinitionFile(options.projectRoot, definition.sourceRootDir) }]
        : []),
    ],
    file: isAbsolute(definition.handler) ? relativeDefinitionFile(options.projectRoot, definition.handler) : definition.handler,
    name: definition.name,
    source: definition.source || "workspace",
  }))
}

/** Console section that lists discovered Workspace Definitions. `vitehub inspect definitions` reads the same data. */
export const workspaceConsoleSection: ViteHubConsoleSectionContribution<WorkspaceInspectionOptions> = {
  description: "Inspect discovered Workspace Definitions and their source roots.",
  icon: "i-lucide-folder-kanban",
  id: "workspaces",
  label: "Workspaces",
  read: inspectWorkspaceDefinitions,
  view: {
    kind: "definition-catalog",
    notice: "Workspace files, Sources, collections, sync state, and processes are not opened or initialized by this build-time catalog.",
  },
}
