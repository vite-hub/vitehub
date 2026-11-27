import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  resolveDefinitionScanRoots,
  normalizeSuffixDefinitionName,
} from "@vite-hub/internal/definition-catalog"
import { resolve } from "pathe"

import { describeQueueContribution } from "./contributions.ts"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

import type { CollectedQueueContribution } from "./contributions.ts"
import type { DiscoveredQueueDefinition } from "./types.ts"

const queueSuffixPattern = /\.queue\.(?:c|m)?[jt]s$/i

/** Discovery source of Queue Definitions that Vite plugins contribute through `vitehub.queues`. */
export const contributedQueueSource = "vite-plugin-contribution"

function normalizeSuffixQueueName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, queueSuffixPattern, { stripPrefix: "src/" })
}

function mergeContributedQueueDefinitions(
  discovered: DiscoveredQueueDefinition[],
  contributions: readonly CollectedQueueContribution[] | undefined,
): DiscoveredQueueDefinition[] {
  if (!contributions?.length) return discovered
  const definitions = new Map(discovered.map(definition => [definition.name, definition]))
  for (const contribution of contributions) {
    const existing = definitions.get(contribution.name)
    if (existing) {
      throw queueErrorDiagnostics.QUEUE_DEFINITION_DUPLICATE({
        message: `[vitehub] Queue "${contribution.name}" is defined more than once:\n  - ${existing.handler}\n  - ${describeQueueContribution(contribution)}\nRename or remove one definition. Each Queue name must have one definition.`,
      })
    }
    const definition: DiscoveredQueueDefinition = {
      contributor: contribution.plugin,
      handler: contribution.definition.module,
      name: contribution.name,
      source: contributedQueueSource,
    }
    if (contribution.reason) definition.reason = contribution.reason
    definitions.set(contribution.name, definition)
  }
  return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name))
}

interface QueueContributionOptions {
  contributions?: readonly CollectedQueueContribution[]
}

export function discoverQueueDefinitions(options:
  | QueueContributionOptions & { mode?: "vite-suffix", rootDir: string, scanDirs?: string[], serverDirs?: string[], serverRootDirs?: string[] }
  | QueueContributionOptions & { mode: "server-queues", scanDirs: string[] }
): DiscoveredQueueDefinition[] {
  if (options.mode === "server-queues") {
    return mergeContributedQueueDefinitions(discoverDefinitions("queue", [
      createDirectoryDefinitionSource("server-queues", options.scanDirs, "queues"),
    ]), options.contributions)
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = [...new Set(options.serverDirs?.map(dir => resolve(dir)) ?? (options.serverRootDirs ?? roots).map(root => resolve(root, "server")))]

  return mergeContributedQueueDefinitions(discoverDefinitions("queue", [
    createSuffixDefinitionSource("vite-suffix", roots, queueSuffixPattern, normalizeSuffixQueueName),
    createDirectoryDefinitionSource("server-queues", serverScanDirs, "queues"),
  ]), options.contributions)
}
