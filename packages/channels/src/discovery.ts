import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"
import { resolve } from "pathe"

import type { DiscoveredChannelDefinition } from "./types.ts"

const channelSuffixPattern = /\.channel\.(?:c|m)?[jt]s$/i

function normalizeSuffixChannelName(rootDir: string, file: string): string {
  return normalizeSuffixDefinitionName(rootDir, file, channelSuffixPattern, { stripPrefix: "src/" })
}

function createDiscoveredChannelDefinition(source: DiscoveredChannelDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredChannelDefinition => ({
    handler: context.file,
    name: context.name,
    source,
  })
}

export function discoverChannelDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[], serverDirs?: string[], serverRootDirs?: string[] }
  | { mode: "server-channels", scanDirs: string[] }
): DiscoveredChannelDefinition[] {
  if (options.mode === "server-channels") {
    return discoverDefinitions("channel", [
      createDirectoryDefinitionSource("server-channels", options.scanDirs, "channels", {
        createDefinition: createDiscoveredChannelDefinition("server-channels"),
        normalizeName: normalizePathDefinitionName,
      }),
    ])
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverRoots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = options.serverDirs ?? [...new Set(options.serverRootDirs || serverRoots)].map(root => resolve(root, "server"))

  return mergeDefinitions(
    "channel",
    discoverDefinitions("channel", [
      createSuffixDefinitionSource("vite-suffix", roots, channelSuffixPattern, normalizeSuffixChannelName, {
        createDefinition: createDiscoveredChannelDefinition("vite-suffix"),
      }),
    ]),
    discoverDefinitions("channel", [
      createDirectoryDefinitionSource("server-channels", serverScanDirs, "channels", {
        createDefinition: createDiscoveredChannelDefinition("server-channels"),
        normalizeName: normalizePathDefinitionName,
      }),
    ]),
  )
}
