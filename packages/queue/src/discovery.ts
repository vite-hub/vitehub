import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  resolveDefinitionScanRoots,
  normalizeSuffixDefinitionName,
} from "@vite-hub/internal/definition-catalog"

import type { DiscoveredQueueDefinition } from "./types.ts"

const queueSuffixPattern = /\.queue\.(?:c|m)?[jt]s$/i

function normalizeSuffixQueueName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, queueSuffixPattern, { stripPrefix: "src/" })
}

export function discoverQueueDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-queues", scanDirs: string[] }
): DiscoveredQueueDefinition[] {
  if (options.mode === "nitro-server-queues") {
    return discoverDefinitions("queue", [
      createDirectoryDefinitionSource("nitro-server-queues", options.scanDirs, "queues"),
    ])
  }

  return discoverDefinitions("queue", [
    createSuffixDefinitionSource("vite-suffix", resolveDefinitionScanRoots(options.rootDir, options.scanDirs), queueSuffixPattern, normalizeSuffixQueueName),
  ])
}
