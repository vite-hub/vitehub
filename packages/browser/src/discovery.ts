import { resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"

import type { DiscoveredDefinition } from "@vite-hub/internal/definition-catalog"

interface DiscoveredBrowserDefinition extends DiscoveredDefinition {
  source: "server-browsers" | "vite-suffix"
}

const browserSuffixPattern = /\.browser\.(?:c|m)?[jt]s$/i

function normalizeSuffixBrowserName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, browserSuffixPattern, { stripPrefix: "src/" })
}

function normalizeDirectoryBrowserName(directory: string, file: string) {
  return normalizePathDefinitionName(directory, file)
}

export function discoverBrowserDefinitions(options: {
  rootDir: string
  scanDirs?: string[]
  serverDirs?: string[]
  serverRootDir?: string
}): DiscoveredBrowserDefinition[] {
  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverRoots = resolveDefinitionScanRoots(options.serverRootDir || options.rootDir, options.scanDirs)
  const serverScanDirs = options.serverDirs ?? serverRoots.map(root => resolve(root, "server"))
  const browserDirectories = serverScanDirs.map(directory => `${resolve(directory, "browsers").replace(/\\/g, "/")}/`)
  const suffixDefinitions = (discoverDefinitions("browser", [
    createSuffixDefinitionSource("vite-suffix", roots, browserSuffixPattern, normalizeSuffixBrowserName),
  ]) as DiscoveredBrowserDefinition[]).filter((definition) => {
    const handler = resolve(definition.handler).replace(/\\/g, "/")
    return !browserDirectories.some(directory => handler.startsWith(directory))
  })

  return mergeDefinitions(
    "browser",
    suffixDefinitions,
    discoverDefinitions("browser", [
      createDirectoryDefinitionSource("server-browsers", serverScanDirs, "browsers", {
        normalizeName: normalizeDirectoryBrowserName,
      }),
    ]) as DiscoveredBrowserDefinition[],
  )
}
