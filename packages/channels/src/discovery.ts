import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"
import { basename, dirname, relative, resolve } from "pathe"

import type { DiscoveredChannelDefinition } from "./types.ts"

const channelSuffixPattern = /\.channel\.(?:c|m)?[jt]s$/i
const channelIndexPattern = /^index\.(?:c|m)?[jt]sx?$/i

function normalizeSuffixChannelName(rootDir: string, file: string): string {
  return normalizeSuffixDefinitionName(rootDir, file, channelSuffixPattern, { stripPrefix: "src/" })
}

function normalizeDirectoryChannelName(directory: string, file: string): string {
  return normalizePathDefinitionName(directory, file).replace(/\.channel$/i, "")
}

function createDiscoveredChannelDefinition(source: DiscoveredChannelDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredChannelDefinition => ({
    handler: context.file,
    name: context.name,
    source,
  })
}

// A folder below `server/channels` with an `index` module is one Channel. Its other files are helpers.
function withChannelFolders(channelRoots: string[], definitions: DiscoveredChannelDefinition[]): DiscoveredChannelDefinition[] {
  const roots = new Set(channelRoots.map(root => resolve(root)))
  const folders = definitions
    .map(definition => resolve(definition.handler))
    .filter(handler => channelIndexPattern.test(basename(handler)) && !roots.has(dirname(handler)))
    .map(handler => dirname(handler))
  return definitions.filter((definition) => {
    const handler = resolve(definition.handler)
    return !folders.some((folder) => {
      if (handler === resolve(folder, basename(handler)) && channelIndexPattern.test(basename(handler))) return false
      const path = relative(folder, handler)
      return !!path && !path.startsWith("..")
    })
  })
}

export function discoverChannelDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[], serverDirs?: string[], serverRootDirs?: string[] }
  | { mode: "server-channels", scanDirs: string[] }
): DiscoveredChannelDefinition[] {
  if (options.mode === "server-channels") {
    return withChannelFolders(options.scanDirs.map(directory => resolve(directory, "channels")), discoverDefinitions("channel", [
      createDirectoryDefinitionSource("server-channels", options.scanDirs, "channels", {
        createDefinition: createDiscoveredChannelDefinition("server-channels"),
        normalizeName: normalizeDirectoryChannelName,
      }),
    ]))
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = options.serverDirs ?? [...new Set(options.serverRootDirs || roots)].map(root => resolve(root, "server"))
  const channelDirectories = serverScanDirs.map(directory => `${resolve(directory, "channels").replace(/\\/g, "/")}/`)
  const suffixDefinitions = discoverDefinitions("channel", [
    createSuffixDefinitionSource("vite-suffix", roots, channelSuffixPattern, normalizeSuffixChannelName, {
      createDefinition: createDiscoveredChannelDefinition("vite-suffix"),
    }),
  ]).filter((definition) => {
    const handler = resolve(definition.handler).replace(/\\/g, "/")
    return !channelDirectories.some(directory => handler.startsWith(directory))
  })

  return mergeDefinitions(
    "channel",
    suffixDefinitions,
    withChannelFolders(serverScanDirs.map(directory => resolve(directory, "channels")), discoverDefinitions("channel", [
      createDirectoryDefinitionSource("server-channels", serverScanDirs, "channels", {
        createDefinition: createDiscoveredChannelDefinition("server-channels"),
        normalizeName: normalizeDirectoryChannelName,
      }),
    ])),
  )
}
