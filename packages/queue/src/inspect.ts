import { summarizeDefinitions } from "@vite-hub/internal/inspect"

import { discoverQueueDefinitions } from "./discovery.ts"

import type { ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ViteHubDefinitionSummary } from "@vite-hub/internal/inspect"

export interface QueueInspectionOptions {
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

/** Summarizes discovered Queue Definitions for the CLI and Console. */
export function inspectQueueDefinitions(options: QueueInspectionOptions): ViteHubDefinitionSummary[] {
  return summarizeDefinitions(
    options.projectRoot,
    discoverQueueDefinitions({ rootDir: options.rootDir, serverDirs: options.serverDirs }),
    "queue",
  )
}

/** Console section that lists discovered Queue Definitions. `vitehub inspect definitions` reads the same data. */
export const queueConsoleSection: ViteHubConsoleSectionContribution<QueueInspectionOptions> = {
  description: "Inspect discovered Queue Definitions and their source metadata.",
  icon: "i-ph-tray-light",
  id: "queues",
  label: "Queues",
  read: inspectQueueDefinitions,
  view: {
    kind: "definition-catalog",
    notice: "Queue backlog, message, and delivery history are not exposed by ViteHub's provider-independent Queue contract yet.",
  },
}
