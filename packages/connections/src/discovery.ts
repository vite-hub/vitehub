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

import { CONNECTION_NAME_MAX_LENGTH } from "./types.ts"

import type { DiscoveredConnectionDefinition } from "./types.ts"

const connectionSuffixPattern = /\.connection\.(?:c|m)?[jt]s$/i

function createDiscoveredConnectionDefinition(source: DiscoveredConnectionDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredConnectionDefinition => {
    if (context.name.length > CONNECTION_NAME_MAX_LENGTH) {
      throw new Error(`Connection name "${context.name}" exceeds ${CONNECTION_NAME_MAX_LENGTH} characters. Rename "${context.file}" so its Env key fits the 512-character limit.`)
    }
    return { handler: context.file, name: context.name, source }
  }
}

/** Discover `server/connections/*.ts` and `*.connection.ts` files. */
export function discoverConnectionDefinitions(options: { rootDir: string, scanDirs?: string[], serverDirs?: string[] }): DiscoveredConnectionDefinition[] {
  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverScanDirs = options.serverDirs ?? roots.map(root => resolve(root, "server"))
  const connectionDirectories = serverScanDirs.map(directory => `${resolve(directory, "connections").replace(/\\/g, "/")}/`)
  const suffixDefinitions = discoverDefinitions("connection", [
    createSuffixDefinitionSource("vite-suffix", roots, connectionSuffixPattern, (rootDir, file) => normalizeSuffixDefinitionName(rootDir, file, connectionSuffixPattern, { stripPrefix: "src/" }), {
      createDefinition: createDiscoveredConnectionDefinition("vite-suffix"),
    }),
  ]).filter((definition) => {
    const handler = resolve(definition.handler).replace(/\\/g, "/")
    return !connectionDirectories.some(directory => handler.startsWith(directory))
  })
  return mergeDefinitions(
    "connection",
    suffixDefinitions,
    discoverDefinitions("connection", [
      createDirectoryDefinitionSource("server-connections", serverScanDirs, "connections", {
        createDefinition: createDiscoveredConnectionDefinition("server-connections"),
        normalizeName: (directory, file) => normalizePathDefinitionName(directory, file).replace(/\.connection$/i, ""),
      }),
    ]),
  )
}
