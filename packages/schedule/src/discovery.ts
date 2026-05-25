import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"

import {
  createDirectoryDefinitionSource,
  createSuffixDefinitionSource,
  discoverDefinitions,
  mergeDefinitions,
  normalizePathDefinitionName,
  normalizeSuffixDefinitionName,
  resolveDefinitionScanRoots,
} from "@vitehub/internal/definition-catalog"

import type { DiscoveredScheduleDefinition } from "./types.ts"

const scheduleSuffixPattern = /\.schedule\.(?:c|m)?[jt]s$/i
const agentSuffixPattern = /\.agent\.(?:c|m)?[jt]s$/i
const agentConfigPattern = /^config\.(?:c|m)?[jt]s$/i
const sourceFileExtensions = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]
const ignoredViteInlineAgentScheduleDirs = new Set(["build", "coverage", "dist", "node_modules", ".output", ".vercel"])

function normalizeScheduleCron(cron: string): string {
  return cron.trim().replace(/\s+/g, " ")
}

function scheduleIdFromCron(cron: string): string {
  return `schedule-${normalizeScheduleCron(cron).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`
}

function isInlineScheduleObjectKey(source: string, stringEnd: number): boolean {
  return /^\s*:/.test(source.slice(stringEnd))
}

function isInlineScheduleObjectValue(source: string, stringStart: number): boolean {
  return /(?:^|[,{]\s*)(["'`])?(?:cron|id)\1?\s*:\s*$/u.test(source.slice(Math.max(0, stringStart - 24), stringStart))
}

function isInlineScheduleStringEntry(source: string, stringStart: number, stringEnd: number): boolean {
  const before = source.slice(0, stringStart).trimEnd().at(-1)
  const after = source.slice(stringEnd).trimStart()[0]
  return (before === undefined || before === ",") && (after === "," || after === undefined)
}

function isStaticStringLiteral(quote: string, value: string): boolean {
  return quote !== "`" || !value.includes("${")
}

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

function readBalancedArguments(source: string, openParen: number): string | undefined {
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
  return splitTopLevelArguments(readBalancedArguments(stripped, openParen) ?? "")[2]
}

function readTopLevelStringProperty(source: string, property: string): string | undefined {
  return readTopLevelStaticStringProperty(source, property)?.value
}

function readTopLevelStaticStringProperty(source: string, property: string): { quote: string, value: string } | undefined {
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
    if (valueQuote !== "\"" && valueQuote !== "'" && valueQuote !== "`") continue
    let value = ""
    for (let valueIndex = valueStart + 1; valueIndex < source.length; valueIndex++) {
      const valueChar = source[valueIndex]
      if (valueChar === "\\") {
        value += source[valueIndex + 1] ?? ""
        valueIndex++
        continue
      }
      if (valueChar === valueQuote) return { quote: valueQuote, value }
      value += valueChar
    }
  }
}

function readScheduleIdOverride(file: string): string | undefined {
  const options = readDefineScheduleOptions(readFileSync(file, "utf8"))
  return options ? readTopLevelStringProperty(options, "id") : undefined
}

function readAllowRuntimeSchedules(file: string): boolean {
  const options = readDefineScheduleOptions(readFileSync(file, "utf8"))
  return /\ballowRuntimeSchedules\s*:\s*true\b/.test(options ?? "")
}

function createDiscoveredScheduleDefinition(source: DiscoveredScheduleDefinition["source"]) {
  return (context: { file: string, name: string }): DiscoveredScheduleDefinition => ({
    allowRuntimeSchedules: readAllowRuntimeSchedules(context.file),
    handler: context.file,
    name: context.name,
    source,
  })
}

function parseInlineAgentScheduleEntries(source: string): Array<{ cron: string, id: string }> {
  const stripped = stripComments(source)
  const entries: Array<{ cron: string, id: string }> = []
  const schedulesPattern = /\bschedule\s*\(\s*\{[\s\S]*?\bschedules\s*:\s*\[([\s\S]*?)\][\s\S]*?\}\s*\)/g
  for (const match of stripped.matchAll(schedulesPattern)) {
    const body = match[1]!
    for (const entry of splitTopLevelArguments(body)) {
      const trimmed = entry.trim()
      const stringEntry = /^(["'`])([^"'`]+)\1$/.exec(trimmed)
      if (stringEntry) {
        if (!isStaticStringLiteral(stringEntry[1]!, stringEntry[2]!)) continue
        const cron = normalizeScheduleCron(stringEntry[2]!)
        entries.push({ cron, id: scheduleIdFromCron(cron) })
        continue
      }

      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue
      const cronProperty = readTopLevelStaticStringProperty(trimmed, "cron")
      if (!cronProperty || !isStaticStringLiteral(cronProperty.quote, cronProperty.value)) continue
      const cron = normalizeScheduleCron(cronProperty.value)
      const id = readTopLevelStringProperty(trimmed, "id") || scheduleIdFromCron(cron)
      entries.push({ cron, id })
    }
  }
  return entries
}

function inlineAgentSchedules(file: string, agentName: string, agentExportName?: string): DiscoveredScheduleDefinition[] {
  return parseInlineAgentScheduleEntries(readFileSync(file, "utf8")).map(schedule => ({
    agentExportName,
    agentName,
    cron: schedule.cron,
    handler: file,
    name: `${agentName}/${schedule.id}`,
    source: "agent-inline-schedule" as const,
  }))
}

function createInlineAgentSchedules(file: string, agentName: string, source: string, agentExportName?: string): DiscoveredScheduleDefinition[] {
  return parseInlineAgentScheduleEntries(source).map(schedule => ({
    agentExportName,
    agentName,
    cron: schedule.cron,
    handler: file,
    name: `${agentName}/${schedule.id}`,
    source: "agent-inline-schedule" as const,
  }))
}

function parseAgentName(source: string): string | undefined {
  return stripComments(source).match(/\bname\s*:\s*["'`]([^"'`]+)["'`]/)?.[1]
}

function readBalancedCall(source: string, openParen: number): string | undefined {
  let depth = 0
  let quote: string | undefined
  let templateExpressionDepth = 0

  for (let index = openParen; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]

    if (quote) {
      if (char === "\\") {
        index++
        continue
      }
      if (quote === "`" && char === "$" && next === "{") {
        templateExpressionDepth++
        index++
        continue
      }
      if (quote === "`" && templateExpressionDepth > 0) {
        if (char === "{") templateExpressionDepth++
        if (char === "}") templateExpressionDepth--
        continue
      }
      if (char === quote) quote = undefined
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "(") depth++
    if (char === ")") {
      depth--
      if (depth === 0) return source.slice(openParen, index + 1)
    }
  }
}

function findDefineAgentCall(source: string, initializerStart: number): string | undefined {
  const initializer = source.slice(initializerStart)
  const leadingWhitespace = initializer.match(/^\s*/)?.[0].length ?? 0
  if (!initializer.slice(leadingWhitespace).startsWith("defineAgent")) return
  const match = /^defineAgent\s*(?:<[^)]*?>\s*)?\(/.exec(initializer.slice(leadingWhitespace))
  if (!match) return
  return readBalancedCall(source, initializerStart + leadingWhitespace + match[0].length - 1)
}

function findNextTopLevelCommaOrSemicolon(source: string, start: number): number {
  let depth = 0
  let quote: string | undefined
  let templateExpressionDepth = 0

  for (let index = start; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]

    if (quote) {
      if (char === "\\") {
        index++
        continue
      }
      if (quote === "`" && char === "$" && next === "{") {
        templateExpressionDepth++
        index++
        continue
      }
      if (quote === "`" && templateExpressionDepth > 0) {
        if (char === "{") templateExpressionDepth++
        if (char === "}") templateExpressionDepth--
        continue
      }
      if (char === quote) quote = undefined
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "(" || char === "[" || char === "{") depth++
    if (char === ")" || char === "]" || char === "}") depth--
    if (depth === 0 && (char === "," || char === ";")) return index
  }
  return source.length
}

function findDeclaratorInitializer(source: string, start: number): { initializerStart: number, localName: string } | undefined {
  const match = /^[\s,]*([A-Za-z_$][\w$]*)/.exec(source.slice(start))
  if (!match) return
  const localName = match[1]!
  let depth = 0
  let quote: string | undefined
  for (let index = start + match[0].length; index < source.length; index++) {
    const char = source[index]!
    const next = source[index + 1]

    if (quote) {
      if (char === "\\") {
        index++
        continue
      }
      if (quote === "`" && char === "$" && next === "{") {
        depth++
        index++
        continue
      }
      if (quote === "`" && depth > 0) {
        if (char === "{") depth++
        if (char === "}") depth--
        continue
      }
      if (char === quote) quote = undefined
      continue
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "<" || char === "{" || char === "[" || char === "(") {
      depth++
      continue
    }
    if (char === ">" || char === "}" || char === "]" || char === ")") {
      depth--
      continue
    }
    if (depth === 0 && (char === "," || char === ";")) return
    if (depth === 0 && char === "=") return { initializerStart: index + 1, localName }
  }
}

function discoverVariableDeclarators(source: string): Array<{ exported: boolean, initializerStart: number, localName: string }> {
  const declarators: Array<{ exported: boolean, initializerStart: number, localName: string }> = []
  for (const match of source.matchAll(/\b(export\s+)?(?:const|let|var)\s+/g)) {
    const exported = !!match[1]
    let cursor = match.index! + match[0].length

    while (cursor < source.length) {
      const declarator = findDeclaratorInitializer(source, cursor)
      if (!declarator) break
      declarators.push({ exported, initializerStart: declarator.initializerStart, localName: declarator.localName })

      const next = findNextTopLevelCommaOrSemicolon(source, declarator.initializerStart)
      if (source[next] !== ",") break
      cursor = next + 1
    }
  }
  return declarators
}

function resolveSourceFile(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [
    base,
    ...sourceFileExtensions.map(extension => `${base}${extension}`),
    ...sourceFileExtensions.map(extension => join(base, `index${extension}`)),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

function discoverNamedAgentExports(file: string, seen = new Set<string>()): Array<{ exportName: string, name: string, source: string }> {
  if (seen.has(file)) return []
  seen.add(file)

  const source = stripComments(readFileSync(file, "utf8"))
  const locals = new Map<string, string>()
  const definitions = new Map<string, { exportName: string, name: string, source: string }>()

  for (const declarator of discoverVariableDeclarators(source)) {
    const callSource = findDefineAgentCall(source, declarator.initializerStart)
    if (!callSource) continue
    locals.set(declarator.localName, callSource)
    if (declarator.exported) {
      definitions.set(declarator.localName, { exportName: declarator.localName, name: declarator.localName, source: callSource })
    }
  }

  for (const match of source.matchAll(/\bexport\s*\{([^}]+)\}\s*(?:from\s*(['"])([^'"]+)\2)?/g)) {
    const importFile = match[3] ? resolveSourceFile(file, match[3]) : undefined
    const importedDefinitions = importFile
      ? new Map(discoverNamedAgentExports(importFile, new Set(seen)).map(definition => [definition.exportName, definition.source]))
      : undefined
    for (const entry of match[1]!.split(",")) {
      const [left, right] = entry.trim().split(/\s+as\s+/)
      const localName = (left || "").trim()
      const exportName = (right || left || "").trim()
      if (!localName || exportName === "default" || !/^[A-Za-z_$][\w$]*$/.test(exportName)) continue
      const callSource = importedDefinitions?.get(localName) ?? locals.get(localName)
      if (callSource) definitions.set(exportName, { exportName, name: exportName, source: callSource })
    }
  }

  return [...definitions.values()].sort((left, right) => left.exportName.localeCompare(right.exportName))
}

function discoverViteInlineAgentSchedules(rootDir: string, scanDirs?: string[]): DiscoveredScheduleDefinition[] {
  const roots = resolveDefinitionScanRoots(rootDir, scanDirs)
  const definitions: DiscoveredScheduleDefinition[] = []
  const walk = (root: string, current: string) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const file = resolve(current, entry.name)
      if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".") && !ignoredViteInlineAgentScheduleDirs.has(entry.name)) {
        walk(root, file)
        continue
      }
      if (!entry.isFile() || !agentSuffixPattern.test(basename(file))) continue
      const name = normalizeSuffixDefinitionName(root, file, agentSuffixPattern, { stripPrefix: "src/" })
      if (name && !name.startsWith("server/")) definitions.push(...inlineAgentSchedules(file, name))
    }
  }
  for (const root of roots) walk(root, root)
  return definitions
}

function discoverNitroInlineAgentSchedules(scanDirs: string[]): DiscoveredScheduleDefinition[] {
  const definitions: DiscoveredScheduleDefinition[] = []
  for (const scanDir of scanDirs) {
    const aggregateFiles = sourceFileExtensions
      .map(extension => resolve(scanDir, `agent${extension}`))
      .filter(file => existsSync(file))
    for (const file of aggregateFiles) {
      for (const agent of discoverNamedAgentExports(file)) {
        definitions.push(...createInlineAgentSchedules(file, agent.name, agent.source, agent.exportName))
      }
    }

    const agentsRoot = resolve(scanDir, "agents")
    const walk = (current: string) => {
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
      for (const entry of entries) {
        const file = resolve(current, entry.name)
        if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith(".")) {
          walk(file)
          continue
        }
        if (!entry.isFile()) continue
        if (agentConfigPattern.test(basename(file))) {
          const source = readFileSync(file, "utf8")
          const agentName = parseAgentName(source) || relative(agentsRoot, dirname(file)).replace(/\\/g, "/")
          if (agentName && agentName !== ".") definitions.push(...inlineAgentSchedules(file, agentName))
          continue
        }
        if (/\.(?:c|m)?[jt]s$/i.test(basename(file))) {
          const agentName = relative(agentsRoot, file).replace(/\.(?:c|m)?[jt]s$/i, "").replace(/\/index$/i, "").replace(/\\/g, "/")
          definitions.push(...inlineAgentSchedules(file, agentName))
        }
      }
    }
    walk(agentsRoot)
  }
  return definitions
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
    const fileDefinitions = discoverDefinitions("schedule", [
      createDirectoryDefinitionSource("nitro-server-schedules", options.scanDirs, "schedules", {
        createDefinition: createDiscoveredScheduleDefinition("nitro-server-schedules"),
        normalizeName: normalizeDirectoryScheduleName,
      }),
    ])
    return mergeDefinitions("schedule", fileDefinitions, discoverNitroInlineAgentSchedules(options.scanDirs))
  }

  const fileDefinitions = discoverDefinitions("schedule", [
    createSuffixDefinitionSource("vite-suffix", resolveDefinitionScanRoots(options.rootDir, options.scanDirs), scheduleSuffixPattern, normalizeSuffixScheduleName, {
      createDefinition: createDiscoveredScheduleDefinition("vite-suffix"),
    }),
  ])
  return mergeDefinitions("schedule", fileDefinitions, discoverViteInlineAgentSchedules(options.rootDir, options.scanDirs))
}
