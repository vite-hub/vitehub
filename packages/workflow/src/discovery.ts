import { normalize, relative, resolve } from "pathe"

import {
  discoverDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
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
    return discoverDefinitions("workflow", [{
      kind: "directory",
      scanDirs: options.scanDirs,
      source: "nitro-server-workflows",
      subdir: "workflows",
    }])
  }

  const roots = new Set([options.rootDir, ...(options.scanDirs || [])].filter(Boolean))
  return discoverDefinitions("workflow", [
    {
      kind: "suffix",
      normalizeName: normalizeSuffixWorkflowName,
      pattern: workflowSuffixPattern,
      roots: [...roots],
      source: "vite-suffix",
    },
    {
      kind: "directory",
      normalizeName(directory, file) {
        const serverWorkflowDir = normalize(directory)
        const normalizedFile = normalize(file)
        if (normalizedFile.startsWith(`${serverWorkflowDir}/`) || normalizedFile === serverWorkflowDir) {
          return normalizePathDefinitionName(serverWorkflowDir, file)
        }
      },
      scanDirs: [...roots].map(root => resolve(root, "server")),
      source: "nitro-server-workflows",
      subdir: "workflows",
    },
  ])
}
