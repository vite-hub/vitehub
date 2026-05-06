import { normalize, resolve } from "pathe"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredWorkflowDefinition } from "./types.ts"

const workflowSuffixPattern = /\.workflow\.(?:c|m)?[jt]s$/i

function normalizeSuffixWorkflowName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, workflowSuffixPattern, { stripPrefix: "src/" })
}

export function discoverWorkflowDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-workflows", scanDirs: string[] }
): DiscoveredWorkflowDefinition[] {
  if (options.mode === "nitro-server-workflows") {
    return discoverDefinitions("workflow", [
      createDirectoryDefinitionSource("nitro-server-workflows", options.scanDirs, "workflows"),
    ])
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  return discoverDefinitions("workflow", [
    createSuffixDefinitionSource("vite-suffix", roots, workflowSuffixPattern, normalizeSuffixWorkflowName),
    createDirectoryDefinitionSource("nitro-server-workflows", roots.map(root => resolve(root, "server")), "workflows", {
      normalizeName(directory, file) {
        const serverWorkflowDir = normalize(directory)
        const normalizedFile = normalize(file)
        if (normalizedFile.startsWith(`${serverWorkflowDir}/`) || normalizedFile === serverWorkflowDir) {
          return normalizePathDefinitionName(serverWorkflowDir, file)
        }
      },
    }),
  ])
}
