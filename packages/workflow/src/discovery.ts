import { normalize, relative, resolve } from "pathe"

import {
  listSourceFiles,
  mergeDefinitions,
  normalizePathDefinitionName,
  registerDefinition,
  sortDefinitions,
} from "@vitehub/internal/definition-discovery"

import type { DiscoveredWorkflowDefinition } from "./types.ts"

const workflowSuffixPattern = /\.workflow\.(?:c|m)?[jt]s$/i

function normalizeSuffixWorkflowName(rootDir: string, file: string) {
  const relativePath = relative(rootDir, file)
  const normalized = relativePath.replace(workflowSuffixPattern, "")
  return normalized.startsWith("src/") ? normalized.slice("src/".length) : normalized
}

function scanRoot(rootDir: string): DiscoveredWorkflowDefinition[] {
  const definitions = new Map<string, DiscoveredWorkflowDefinition>()
  const serverWorkflowDir = normalize(resolve(rootDir, "server", "workflows"))

  for (const file of listSourceFiles(rootDir)) {
    const normalizedFile = normalize(file)
    if (normalizedFile.startsWith(`${serverWorkflowDir}/`) || normalizedFile === serverWorkflowDir) {
      const name = normalizePathDefinitionName(serverWorkflowDir, file)
      if (name) {
        registerDefinition(definitions, { handler: file, name, source: "nitro-server-workflows" }, "workflow")
      }
      continue
    }
    if (workflowSuffixPattern.test(file)) {
      const name = normalizeSuffixWorkflowName(rootDir, file)
      if (name) {
        registerDefinition(definitions, { handler: file, name, source: "vite-suffix" }, "workflow")
      }
    }
  }

  return sortDefinitions(definitions)
}

function scanNitroWorkflowFiles(scanDirs: string[]): DiscoveredWorkflowDefinition[] {
  const definitions = new Map<string, DiscoveredWorkflowDefinition>()

  for (const scanDir of scanDirs) {
    const workflowDir = resolve(scanDir, "workflows")
    for (const file of listSourceFiles(workflowDir)) {
      const name = normalizePathDefinitionName(workflowDir, file)
      if (name) {
        registerDefinition(definitions, { handler: file, name, source: "nitro-server-workflows" }, "workflow")
      }
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
  return mergeDefinitions("workflow", ...[...roots].map(scanRoot))
}
