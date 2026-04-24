import { relative, resolve } from "node:path"
import {
  createRuntimeRegistryContents,
  listMatchingFiles,
  listSourceFiles,
  mergeDefinitions,
  normalizePathDefinitionName,
  registerDefinition,
  sortDefinitions,
} from "@vitehub/internal/definition-discovery"

import type { DiscoveredQueueDefinition } from "./types.ts"

const queueSuffixPattern = /\.queue\.(?:c|m)?[jt]s$/i

function listQueueFiles(root: string): string[] {
  return listMatchingFiles(root, name => queueSuffixPattern.test(name))
}

function normalizeSuffixQueueName(rootDir: string, file: string) {
  const relativePath = relative(rootDir, file).replace(/\\/g, "/")
  const normalized = relativePath.replace(queueSuffixPattern, "")
  return normalized.startsWith("src/") ? normalized.slice("src/".length) : normalized
}

function scanSuffixQueueFiles(rootDir: string): DiscoveredQueueDefinition[] {
  const definitions = new Map<string, DiscoveredQueueDefinition>()

  for (const file of listQueueFiles(rootDir)) {
    const name = normalizeSuffixQueueName(rootDir, file)
    if (!name) {
      continue
    }

    registerDefinition(definitions, { handler: file, name, source: "vite-suffix" }, "queue")
  }

  return sortDefinitions(definitions)
}

function scanNitroQueueFiles(scanDirs: string[]): DiscoveredQueueDefinition[] {
  const definitions = new Map<string, DiscoveredQueueDefinition>()

  for (const scanDir of scanDirs) {
    const queueDir = resolve(scanDir, "queues")
    for (const file of listSourceFiles(queueDir)) {
      const name = normalizePathDefinitionName(queueDir, file)
      if (!name) {
        continue
      }

      registerDefinition(definitions, { handler: file, name, source: "nitro-server-queues" }, "queue")
    }
  }

  return sortDefinitions(definitions)
}

export function discoverQueueDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-queues", scanDirs: string[] }
): DiscoveredQueueDefinition[] {
  if (options.mode === "nitro-server-queues") {
    return scanNitroQueueFiles(options.scanDirs)
  }

  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return mergeDefinitions("queue", ...[...roots].map(root => scanSuffixQueueFiles(root)))
}

export function createQueueRegistryContents(registryFile: string, definitions: DiscoveredQueueDefinition[]) {
  return createRuntimeRegistryContents(registryFile, definitions)
}
