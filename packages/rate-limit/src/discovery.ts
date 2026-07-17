import { resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"

import type { DiscoveredRateLimitDefinition } from "./types.ts"

const rateLimitSuffixPattern = /\.rate-limit\.(?:c|m)?[jt]s$/i

function normalizeSuffixRateLimitName(rootDir: string, file: string): string {
  return normalizeSuffixDefinitionName(rootDir, file, rateLimitSuffixPattern, { stripPrefix: "src/" })
}

export function discoverRateLimitDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "server-rate-limits", scanDirs: string[] }
): DiscoveredRateLimitDefinition[] {
  if (options.mode === "server-rate-limits") {
    return discoverDefinitions("rate limit", [
      createDirectoryDefinitionSource("server-rate-limits", options.scanDirs, "rate-limits"),
    ])
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = roots.map(root => resolve(root, "server"))
  return mergeDefinitions(
    "rate limit",
    discoverDefinitions("rate limit", [
      createSuffixDefinitionSource("vite-suffix", roots, rateLimitSuffixPattern, normalizeSuffixRateLimitName),
    ]),
    discoverDefinitions("rate limit", [
      createDirectoryDefinitionSource("server-rate-limits", serverScanDirs, "rate-limits"),
    ]),
  ) as DiscoveredRateLimitDefinition[]
}
