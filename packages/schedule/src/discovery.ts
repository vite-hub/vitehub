import { readFileSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vite-hub/internal/definition-catalog"
import { findDefaultExportCall, readObjectProperty } from "@vite-hub/internal/source-scanner"

import type { DiscoveredScheduleDefinition } from "./types.ts"

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i

function readScheduleDiscoveryMetadata(file: string): Pick<DiscoveredScheduleDefinition, "allowRuntimeSchedules" | "runtimeOnly"> {
  const definition = findDefaultExportCall(readFileSync(file, "utf8"), ["defineSchedule", "defineScheduleTarget"])
  if (!definition) return { allowRuntimeSchedules: false }
  if (definition.name === "defineScheduleTarget") {
    return { allowRuntimeSchedules: true, runtimeOnly: true }
  }
  return { allowRuntimeSchedules: readObjectProperty(definition.argument, "allowRuntimeSchedules") === "true" }
}

function createDiscoveredScheduleDefinition(source: DiscoveredScheduleDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredScheduleDefinition => {
    const metadata = readScheduleDiscoveryMetadata(context.file)
    return {
      ...metadata,
      handler: context.file,
      name: context.name,
      source,
    }
  }
}

function normalizeSuffixScheduleName(rootDir: string, file: string) {
  return normalizeSuffixDefinitionName(rootDir, file, scheduleSuffixPattern, { stripPrefix: "src/" })
}

function normalizeDirectoryScheduleName(directory: string, file: string) {
  return normalizePathDefinitionName(directory, file)
}

export function discoverScheduleDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[], serverDirs?: string[], serverRootDir?: string }
  | { mode: "server-schedules", scanDirs: string[] }
): DiscoveredScheduleDefinition[] {
  if (options.mode === "server-schedules") {
    return discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("server-schedules", options.scanDirs, "schedules", {
        createDefinition: createDiscoveredScheduleDefinition("server-schedules"),
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ])
  }

  const roots = resolveDefinitionScanRoots(options.rootDir, options.scanDirs)
  const serverRoots = resolveDefinitionScanRoots(options.serverRootDir || options.rootDir, options.scanDirs)
  const serverScanDirs = options.serverDirs ?? serverRoots.map(root => resolve(root, "server"))

  for (const directory of serverScanDirs) {
    if (roots.every((root) => {
      const path = relative(resolve(root), resolve(directory))
      return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)
    })) {
      roots.push(directory)
    }
  }

  return mergeDefinitions(
    "schedule",
    discoverDefinitions("schedule", [
      createSuffixDefinitionSource("vite-suffix", roots, scheduleSuffixPattern, normalizeSuffixScheduleName, {
        createDefinition: createDiscoveredScheduleDefinition("vite-suffix"),
      }),
    ]).filter(definition => !serverScanDirs.some((directory) => {
      const path = relative(resolve(directory, "schedules"), definition.handler)
      return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
    })),
    discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("server-schedules", serverScanDirs, "schedules", {
        createDefinition: createDiscoveredScheduleDefinition("server-schedules"),
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ]),
  )
}
