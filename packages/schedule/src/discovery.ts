import { readFileSync } from "node:fs"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vitehub/internal/definition-catalog"
import { findIdentifierCalls } from "@vitehub/internal/source-scanner"

import type { DiscoveredScheduleDefinition } from "./types.ts"

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i

function readDefineScheduleOptions(source: string): string | undefined {
  return findIdentifierCalls(source, "defineSchedule")[0]?.arguments[2]
}

function readTopLevelStringProperty(source: string, property: string): string | undefined {
  let depth = 0
  let quote: string | undefined
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
    if (char === "{" || char === "[" || char === "(") {
      depth++
      continue
    }
    if (char === "}" || char === "]" || char === ")") {
      depth--
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      if (depth !== 1 || char === "`" || !source.startsWith(property, index + 1) || source[index + property.length + 1] !== char) {
        quote = char
        continue
      }
    }
    if (depth !== 1) continue
    let valueStart: number
    if (source[index] === "\"" || source[index] === "'") {
      valueStart = index + property.length + 2
    }
    else {
      if (!source.startsWith(property, index)) continue
      const before = source[index - 1] ?? ""
      const after = source[index + property.length] ?? ""
      if (/[\w$]/.test(before) || /[\w$]/.test(after)) continue
      valueStart = index + property.length
    }
    while (/\s/.test(source[valueStart] ?? "")) valueStart++
    if (source[valueStart] !== ":") continue
    valueStart++
    while (/\s/.test(source[valueStart] ?? "")) valueStart++
    const valueQuote = source[valueStart]
    if (valueQuote !== "\"" && valueQuote !== "'") continue
    let value = ""
    for (let valueIndex = valueStart + 1; valueIndex < source.length; valueIndex++) {
      const valueChar = source[valueIndex]
      if (valueChar === "\\") {
        value += source[valueIndex + 1] ?? ""
        valueIndex++
        continue
      }
      if (valueChar === valueQuote) return value
      value += valueChar
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
