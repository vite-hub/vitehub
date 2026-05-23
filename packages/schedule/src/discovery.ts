import { readFileSync } from "node:fs"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredScheduleDefinition } from "./types.ts"

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i

function readBalancedCall(source: string, openParen: number): string | undefined {
  let depth = 0
  let quote: string | undefined
  for (let index = openParen; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === "\\") {
        index++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "(" || char === "{" || char === "[") {
      depth++
      continue
    }
    if (char === ")" || char === "}" || char === "]") {
      depth--
      if (depth === 0) return source.slice(openParen + 1, index)
    }
  }
}

function splitTopLevelArguments(source: string): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | undefined
  let start = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === "\\") {
        index++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "(" || char === "{" || char === "[") {
      depth++
      continue
    }
    if (char === ")" || char === "}" || char === "]") {
      depth--
      continue
    }
    if (char === "," && depth === 0) {
      args.push(source.slice(start, index))
      start = index + 1
    }
  }
  args.push(source.slice(start))
  return args
}

function readDefineScheduleOptions(source: string): string | undefined {
  const match = /\bdefineSchedule\s*(?:<[^>]+>\s*)?\(/.exec(source)
  if (!match) return undefined
  const openParen = match.index + match[0].length - 1
  return splitTopLevelArguments(readBalancedCall(source, openParen) ?? "")[2]
}

function readScheduleIdOverride(file: string): string | undefined {
  const match = readDefineScheduleOptions(readFileSync(file, "utf8"))?.match(/\bid\s*:\s*(["'])([^"']+)\1/)
  return match?.[2]
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
