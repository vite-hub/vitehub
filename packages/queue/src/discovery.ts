import { relative, resolve } from "node:path"
import {
  discoverDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
} from "@vitehub/internal/definition-catalog"

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
    return discoverDefinitions("queue", [{
      kind: "directory",
      scanDirs: options.scanDirs,
      source: "nitro-server-queues",
      subdir: "queues",
    }])
  }

  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return discoverDefinitions("queue", [{
    kind: "suffix",
    normalizeName: normalizeSuffixQueueName,
    pattern: queueSuffixPattern,
    roots: [...roots],
    source: "vite-suffix",
  }])
}
