import { summarizeDefinitions } from "@vite-hub/internal/inspect"

import { discoverQueueDefinitions } from "./discovery.ts"
import { getCloudflareQueueBindingName } from "./integrations/cloudflare.ts"
import { getCloudflareQueueName } from "./internal/cloudflare-resource-name.ts"

import type { CollectedQueueContribution } from "./contributions.ts"
import type { ViteHubConsoleSectionContribution } from "@vite-hub/internal/console"
import type { ViteHubDefinitionSummary, ViteHubResourceSummary } from "@vite-hub/internal/inspect"

export interface QueueInspectionOptions {
  /** Queue Definitions that Vite plugins contribute through `vitehub.queues`. */
  contributions?: readonly CollectedQueueContribution[]
  projectRoot: string
  rootDir: string
  serverDirs?: string[]
}

/** Summarizes discovered Queue Definitions for the CLI and Console. */
export function inspectQueueDefinitions(options: QueueInspectionOptions, definitions = discoverQueueDefinitions(options)): ViteHubDefinitionSummary[] {
  return summarizeDefinitions(options.projectRoot, definitions, "queue").map((summary, index) => {
    const { contributor, reason } = definitions[index]!
    if (!contributor) return summary
    return { ...summary, fields: [{ label: "Contributed by", value: contributor }, ...(reason ? [{ label: "Reason", value: reason }] : [])] }
  })
}

/** Lists the Cloudflare Queues that Queue Definitions bind by name. Reads local files only. */
export function inspectQueueResources(options: QueueInspectionOptions & { binding?: string, namePrefix?: string }, definitions = discoverQueueDefinitions(options)): ViteHubResourceSummary[] {
  return definitions.map(definition => ({
    binding: options.binding ?? getCloudflareQueueBindingName(definition.name),
    definition: definition.name,
    host: "cloudflare",
    kind: "cloudflare-queue",
    name: getCloudflareQueueName(definition.name, options.namePrefix),
    owner: "queue",
    source: "name",
  }))
}

/** Console section that lists discovered Queue Definitions. `vitehub inspect definitions` reads the same data. */
export const queueConsoleSection: ViteHubConsoleSectionContribution<QueueInspectionOptions> = {
  description: "Inspect discovered Queue Definitions and their source metadata.",
  icon: "i-vitehub-queue",
  id: "queues",
  label: "Queues",
  read: inspectQueueDefinitions,
  view: {
    kind: "definition-catalog",
    notice: "Cloudflare and Vercel do not expose Queue backlog or delivery history through ViteHub. The local provider reports its job directory and job counts in `vitehub queue list`.",
  },
}
