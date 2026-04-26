import { relative, resolve } from "node:path"
import {
  listMatchingFiles,
  listSourceFiles,
  mergeDefinitions,
  normalizePathDefinitionName,
  registerDefinition,
  sortDefinitions,
} from "@vitehub/internal/definition-discovery"

import type { DiscoveredWorkflowDefinition } from "./types.ts"

const workflowSuffixPattern = /\.workflow\.(?:c|m)?[jt]s$/i

function listWorkflowFiles(root: string): string[] {
  return listMatchingFiles(root, name => workflowSuffixPattern.test(name))
}

function normalizeSuffixWorkflowName(rootDir: string, file: string) {
  const relativePath = relative(rootDir, file).replace(/\\/g, "/")
  const normalized = relativePath.replace(workflowSuffixPattern, "")
  return normalized.startsWith("src/") ? normalized.slice("src/".length) : normalized
}

function scanSuffixWorkflowFiles(rootDir: string): DiscoveredWorkflowDefinition[] {
  const definitions = new Map<string, DiscoveredWorkflowDefinition>()

  for (const file of listWorkflowFiles(rootDir)) {
    const name = normalizeSuffixWorkflowName(rootDir, file)
    if (!name) {
      continue
    }

    registerDefinition(definitions, { handler: file, name, source: "vite-suffix" }, "workflow")
  }

  return sortDefinitions(definitions)
}

function scanNitroWorkflowFiles(scanDirs: string[]): DiscoveredWorkflowDefinition[] {
  const definitions = new Map<string, DiscoveredWorkflowDefinition>()

  for (const scanDir of scanDirs) {
    const workflowDir = resolve(scanDir, "workflows")
    for (const file of listSourceFiles(workflowDir)) {
      const name = normalizePathDefinitionName(workflowDir, file)
      if (!name) {
        continue
      }

      registerDefinition(definitions, { handler: file, name, source: "nitro-server-workflows" }, "workflow")
    }
  }

  return sortDefinitions(definitions)
}

export function discoverWorkflowDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-workflows", scanDirs: string[] }
): DiscoveredWorkflowDefinition[] {
  if (options.mode === "nitro-server-workflows") {
    return scanNitroWorkflowFiles(options.scanDirs)
  }

  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return mergeDefinitions(
    "workflow",
    ...[...roots].flatMap(root => [
      scanSuffixWorkflowFiles(root),
      scanNitroWorkflowFiles([resolve(root, "server")]),
    ]),
  )
}
