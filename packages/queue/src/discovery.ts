import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  resolveDefinitionScanRoots,
  normalizeSuffixDefinitionName,
} from "@vite-hub/internal/definition-catalog"
import { resolve } from "pathe"

import type { DiscoveredQueueDefinition } from "./types.ts"

const queueSuffixPattern = /\.queue\.(?:c|m)?[jt]s$/i

function normalizeSuffixQueueName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, queueSuffixPattern, { stripPrefix: "src/" })
}

export function discoverQueueDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[], serverDirs?: string[], serverRootDirs?: string[] }
  | { mode: "server-queues", scanDirs: string[] }
): DiscoveredQueueDefinition[] {
  if (options.mode === "server-queues") {
    return discoverDefinitions("queue", [
      createDirectoryDefinitionSource("server-queues", options.scanDirs, "queues"),
    ])
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = options.serverDirs || [...new Set(options.serverRootDirs || roots)].map(root => resolve(root, "server"))

  return mergeDefinitions(
    "queue",
    discoverDefinitions("queue", [
      createSuffixDefinitionSource("vite-suffix", roots, queueSuffixPattern, normalizeSuffixQueueName),
    ]),
    discoverDefinitions("queue", [
      createDirectoryDefinitionSource("server-queues", serverScanDirs, "queues"),
    ]),
  )
}
