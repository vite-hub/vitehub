import { readFileSync } from "node:fs"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vitehub/internal/definition-catalog"
import {
  findIdentifierCalls,
  splitTopLevel,
} from "@vitehub/internal/source-scanner"

import type { DiscoveredScheduleDefinition } from "./types.ts"

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i

function isExportDefaultCall(source: string, start: number) {
  return /(?:^|[^\w$])export\s+default\s*$/.test(source.slice(0, start))
}

function readDefineScheduleOptions(source: string): string | undefined {
  const calls = findIdentifierCalls(source, "defineSchedule")
  return (calls.find(call => isExportDefaultCall(source, call.start)) ?? calls[0])?.arguments[2]
}

function readTopLevelStringProperty(source: string, property: string): string | undefined {
  const objectSource = source.trim()
  if (!objectSource.startsWith("{") || !objectSource.endsWith("}")) return undefined

  for (const entry of splitTopLevel(objectSource.slice(1, -1))) {
    const [key, ...valueParts] = splitTopLevel(entry, ":")
    const normalizedKey = key?.trim().replace(/^(['"])(.*)\1$/, "$2")
    if (normalizedKey !== property) continue
    const value = valueParts.join(":").trim()
    const match = value.match(/^(['"])((?:\\.|(?!\1).)*)\1$/)
    if (match) {
      return match[2]?.replace(/\\(.)/g, "$1")
    }
  }
}

function readScheduleIdOverride(file: string): string | undefined {
  const options = readDefineScheduleOptions(readFileSync(file, "utf8"))
  return options ? readTopLevelStringProperty(options, "id") : undefined
}

function normalizeSuffixScheduleName(rootDir: string, file: string) {
  return readScheduleIdOverride(file)
    ?? normalizeSuffixDefinitionName(rootDir, file, scheduleSuffixPattern, { stripPrefix: "src/" })
}

function normalizeDirectoryScheduleName(directory: string, file: string) {
  return readScheduleIdOverride(file) ?? normalizePathDefinitionName(directory, file)
}

export function discoverScheduleDefinitions(options:
  | { mode?: "vite-suffix", rootDir: string, scanDirs?: string[] }
  | { mode: "nitro-server-schedules", scanDirs: string[] }
): DiscoveredScheduleDefinition[] {
  if (options.mode === "nitro-server-schedules") {
    return discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("nitro-server-schedules", options.scanDirs, "schedules", {
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ])
  }

  return discoverDefinitions("schedule", [
    createSuffixDefinitionSource("vite-suffix", resolveDefinitionScanRoots(options.rootDir, options.scanDirs), scheduleSuffixPattern, normalizeSuffixScheduleName),
  ])
}
