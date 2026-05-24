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

function stripComments(source: string): string {
  let stripped = ""
  let quote: string | undefined
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]

    if (quote) {
      stripped += char
      if (char === "\\") {
        stripped += next ?? ""
        index++
        continue
      }
      if (char === quote) quote = undefined
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      stripped += char
      continue
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++
      stripped += "\n"
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") stripped += "\n"
        index++
      }
      index++
      continue
    }

    stripped += char
  }
  return stripped
}

function readBalancedCall(source: string, openParen: number): string | undefined {
  let depth = 0
  let quote: string | undefined
  let previousSignificant = ""
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
    if (char === "/" && previousSignificant && /[({[=,:!&|?;>]/.test(previousSignificant)) {
      index++
      while (index < source.length) {
        const current = source[index]
        if (current === "\\") {
          index += 2
          continue
        }
        if (current === "/") break
        index++
      }
      while (/[a-z]/i.test(source[index + 1] ?? "")) index++
      previousSignificant = "/"
      continue
    }
    if (char === "(" || char === "{" || char === "[") {
      depth++
      previousSignificant = char
      continue
    }
    if (char === ")" || char === "}" || char === "]") {
      depth--
      if (depth === 0) return source.slice(openParen + 1, index)
      previousSignificant = char
      continue
    }
    if (!/\s/.test(char ?? "")) {
      previousSignificant = char ?? ""
    }
  }
}

function splitTopLevelArguments(source: string): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | undefined
  let previousSignificant = ""
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
    if (char === "/" && previousSignificant && /[({[=,:!&|?;>]/.test(previousSignificant)) {
      index++
      while (index < source.length) {
        const current = source[index]
        if (current === "\\") {
          index += 2
          continue
        }
        if (current === "/") break
        index++
      }
      while (/[a-z]/i.test(source[index + 1] ?? "")) index++
      previousSignificant = "/"
      continue
    }
    if (char === "(" || char === "{" || char === "[") {
      depth++
      previousSignificant = char
      continue
    }
    if (char === ")" || char === "}" || char === "]") {
      depth--
      previousSignificant = char
      continue
    }
    if (char === "," && depth === 0) {
      args.push(source.slice(start, index))
      start = index + 1
    }
    if (!/\s/.test(char ?? "")) {
      previousSignificant = char ?? ""
    }
  }
  args.push(source.slice(start))
  return args
}

function findDefineScheduleOpenParen(source: string): number | undefined {
  for (const match of source.matchAll(/\bdefineSchedule\b/g)) {
    let index = match.index! + match[0].length
    while (/\s/.test(source[index] ?? "")) index++
    if (source[index] === "<") {
      let depth = 0
      for (; index < source.length; index++) {
        if (source[index] === "<") depth++
        if (source[index] === ">") {
          depth--
          if (depth === 0) {
            index++
            break
          }
        }
      }
      while (/\s/.test(source[index] ?? "")) index++
    }
    if (source[index] === "(") return index
  }
}

function readDefineScheduleOptions(source: string): string | undefined {
  const stripped = stripComments(source)
  const openParen = findDefineScheduleOpenParen(stripped)
  if (openParen === undefined) return undefined
  return splitTopLevelArguments(readBalancedCall(stripped, openParen) ?? "")[2]
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
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
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
    if (depth !== 1 || !source.startsWith(property, index)) continue
    const before = source[index - 1] ?? ""
    const after = source[index + property.length] ?? ""
    if (/[\w$]/.test(before) || /[\w$]/.test(after)) continue
    let valueStart = index + property.length
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
