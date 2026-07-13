import { readFileSync } from "node:fs"
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { createDefaultCloudflareOutputRoot, createDefaultNetlifyOutputRoot, createDefaultVercelOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { bundleEsmEntry } from "@vite-hub/internal/build/esbuild"
import { createImportPath, ensureGeneratedDir } from "@vite-hub/internal/build/paths"
import { createNodeFunctionConfig, createVercelConfigJson } from "@vite-hub/internal/build/vercel-config"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"

import { discoverScheduleDefinitions } from "../discovery.ts"
import { getVercelSchedulePath } from "../integrations/vercel.ts"

import type { Plugin } from "esbuild"
import type { DiscoveredScheduleDefinition } from "../types.ts"

export const schedulePackageName = "@vite-hub/schedule"
const scheduleStaticRuntimeImport = "@vite-hub/schedule/runtime/static"
const productName = "schedule"
const cloudflareOutputStateFileName = "cloudflare-output.json"
const denoCronFileName = "deno-cron.mjs"
const generatedRegistryFileName = "registry.mjs"

export function resolveScheduleRuntimeEntry(metaUrl = import.meta.url) {
  const file = fileURLToPath(metaUrl)
  const normalizedFile = file.replace(/\\/g, "/")
  if (normalizedFile.endsWith("/src/internal/provider-output.ts")) {
    return resolve(dirname(file), "../runtime/static.ts")
  }
  if (normalizedFile.endsWith("/dist/internal/provider-output.js")) {
    return resolve(dirname(file), "../runtime/static.js")
  }
  return normalizedFile.includes("/dist/")
    ? resolve(dirname(file), "runtime/static.js")
    : resolve(dirname(file), "dist/runtime/static.js")
}

export function resolveScheduleDefinitionEntry(metaUrl = import.meta.url) {
  const file = fileURLToPath(metaUrl)
  const normalizedFile = file.replace(/\\/g, "/")
  if (normalizedFile.endsWith("/src/internal/provider-output.ts")) {
    return resolve(dirname(file), "../definition.ts")
  }
  if (normalizedFile.endsWith("/dist/internal/provider-output.js")) {
    return resolve(dirname(file), "../definition.js")
  }
  return normalizedFile.includes("/dist/")
    ? resolve(dirname(file), "definition.js")
    : resolve(dirname(file), "dist/definition.js")
}

const scheduleRuntimeEntry = resolveScheduleRuntimeEntry()
const scheduleDefinitionEntry = resolveScheduleDefinitionEntry()

function staticScheduleDefinitions(definitions: DiscoveredScheduleDefinition[]): DiscoveredScheduleDefinition[] {
  return definitions.filter(definition => definition.runtimeOnly !== true)
}

interface GeneratedScheduleArtifacts {
  cloudflareWorkerFile: string
  denoCronFile: string
  definitions: DiscoveredScheduleDefinition[]
  generatedDir: string
  registryFile: string
  vercelServerFile: string
}

interface GenerateProviderOutputsOptions {
  bundleAlias?: Record<string, string>
  clientOutDir: string
  definitions?: DiscoveredScheduleDefinition[]
  rootDir: string
  runtimeImport?: string
  source?: DiscoveredScheduleDefinition["source"]
}

async function removeEmptyDirectories(directory: string, rootDir: string): Promise<void> {
  const root = resolve(rootDir)
  let current = resolve(directory)
  const pathFromRoot = relative(root, current)
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return

  while (current !== root) {
    try {
      await rmdir(current)
    }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        current = dirname(current)
        continue
      }
      if (code === "ENOTEMPTY" || code === "EEXIST") return
      throw error
    }
    current = dirname(current)
  }
}

export interface NetlifyScheduleFunctionOutput {
  cron: string
  file: string
  name: string
  source: string
}

const cronFieldPattern = /^[*,/\-0-9]+$/

export function validateProviderCron(cron: string, scheduleName: string): void {
  const fields = cron.trim().split(/\s+/)
  const hasVercelDayConflict = fields[2] !== "*" && fields[4] !== "*"
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field)) || hasVercelDayConflict) {
    throw new Error(`Schedule "${scheduleName}" uses cron "${cron}", but provider wake output only supports five-field UTC cron syntax compatible with Cloudflare, Vercel, and Netlify.`)
  }
}

function readStaticScheduleCron(file: string, scheduleName: string): string {
  const source = readFileSync(file, "utf8")
  const cron = readDefaultDefineScheduleCron(source)
  if (!cron) {
    throw new Error(`Schedule "${scheduleName}" must declare a static cron string for provider wake output.`)
  }
  return cron
}

function skipQuoted(source: string, index: number): number {
  const quote = source[index]
  if (quote === "`") return skipTemplateLiteral(source, index)

  index += 1
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === quote) {
      return index + 1
    }
    index += 1
  }
  return index
}

function skipTemplateExpression(source: string, index: number): number {
  let depth = 1
  while (index < source.length) {
    const char = source[index]
    if (char === "\"" || char === "'" || char === "`") {
      index = skipQuoted(source, index)
      continue
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index)
      continue
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index)
      continue
    }
    if (char === "/" && canStartRegexLiteral(source, index)) {
      index = skipRegexLiteral(source, index)
      continue
    }
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
    index += 1
  }
  return index
}

function skipTemplateLiteral(source: string, index: number): number {
  index += 1
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2
      continue
    }
    if (source[index] === "`") {
      return index + 1
    }
    if (source.startsWith("${", index)) {
      index = skipTemplateExpression(source, index + 2)
      continue
    }
    index += 1
  }
  return index
}

function skipLineComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index + 2)
  return newline === -1 ? source.length : newline + 1
}

function skipBlockComment(source: string, index: number): number {
  const close = source.indexOf("*/", index + 2)
  return close === -1 ? source.length : close + 2
}

function isInsideNonCode(source: string, targetIndex: number): boolean {
  for (let index = 0; index < targetIndex; index += 1) {
    const char = source[index]
    if (char === "\"" || char === "'" || char === "`") {
      const quotedEnd = skipQuoted(source, index)
      if (targetIndex < quotedEnd) return true
      index = quotedEnd - 1
      continue
    }
    if (source.startsWith("//", index)) {
      const commentEnd = skipLineComment(source, index)
      if (targetIndex < commentEnd) return true
      index = commentEnd - 1
      continue
    }
    if (source.startsWith("/*", index)) {
      const commentEnd = skipBlockComment(source, index)
      if (targetIndex < commentEnd) return true
      index = commentEnd - 1
    }
  }
  return false
}

function skipIgnorable(source: string, index: number): number {
  while (index < source.length) {
    if (/\s/.test(source[index]!)) {
      index += 1
      continue
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index)
      continue
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index)
      continue
    }
    break
  }
  return index
}

function previousSignificantToken(source: string, index: number): string {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(source[cursor]!)) cursor -= 1
  if (cursor < 0) return ""

  const wordEnd = cursor + 1
  while (cursor >= 0 && /[$\w]/.test(source[cursor]!)) cursor -= 1
  if (cursor < wordEnd - 1) return source.slice(cursor + 1, wordEnd)

  return source[cursor]!
}

function canStartRegexLiteral(source: string, index: number): boolean {
  const token = previousSignificantToken(source, index)
  return token === ""
    || token === "await"
    || token === "case"
    || token === "delete"
    || token === "return"
    || token === "throw"
    || token === "typeof"
    || token === "void"
    || /^[({[=,:;!&|?+\-*%^~<>]$/.test(token)
}

function skipRegexLiteral(source: string, index: number): number {
  let inCharacterClass = false
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor]
    if (char === "\\") {
      cursor += 1
      continue
    }
    if (char === "[") {
      inCharacterClass = true
      continue
    }
    if (char === "]") {
      inCharacterClass = false
      continue
    }
    if (char === "/" && !inCharacterClass) {
      cursor += 1
      while (/[a-z]/i.test(source[cursor] ?? "")) cursor += 1
      return cursor
    }
  }
  return source.length
}

function readBalancedObject(source: string, openIndex: number): string | undefined {
  if (source[openIndex] !== "{") return undefined

  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\"" || char === "'" || char === "`") {
      index = skipQuoted(source, index) - 1
      continue
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (char === "/" && canStartRegexLiteral(source, index)) {
      index = skipRegexLiteral(source, index) - 1
      continue
    }
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        return source.slice(openIndex + 1, index)
      }
    }
  }
}

function splitTopLevelProperties(source: string): string[] {
  const properties: string[] = []
  let depth = 0
  let start = 0

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\"" || char === "'" || char === "`") {
      index = skipQuoted(source, index) - 1
      continue
    }
    if (source.startsWith("//", index)) {
      index = skipLineComment(source, index) - 1
      continue
    }
    if (source.startsWith("/*", index)) {
      index = skipBlockComment(source, index) - 1
      continue
    }
    if (char === "/" && canStartRegexLiteral(source, index)) {
      index = skipRegexLiteral(source, index) - 1
      continue
    }
    if (char === "{" || char === "[" || char === "(") depth += 1
    if (char === "}" || char === "]" || char === ")") depth -= 1
    if (char === "," && depth === 0) {
      properties.push(source.slice(start, index))
      start = index + 1
    }
  }

  properties.push(source.slice(start))
  return properties
}

function readStaticStringLiteral(source: string): string | undefined {
  const value = source.trim()
  const quote = value[0]
  if (quote !== "\"" && quote !== "'" && quote !== "`") return undefined

  let result = ""
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]
    if (char === "\\") {
      result += value[index + 1] ?? ""
      index += 1
      continue
    }
    if (char === quote) {
      if (skipIgnorable(value, index + 1) !== value.length) {
        return undefined
      }
      return result
    }
    result += char
  }
}

function readTopLevelCronProperty(objectSource: string): string | undefined {
  for (const property of splitTopLevelProperties(objectSource)) {
    const colon = property.indexOf(":")
    if (colon === -1) continue

    const keyStart = skipIgnorable(property, 0)
    const key = property.slice(keyStart, colon).trim().replace(/^["'`](.*)["'`]$/s, "$1")
    if (key !== "cron") continue

    const cron = readStaticStringLiteral(property.slice(colon + 1))
    if (!cron) {
      throw new Error("Schedule must declare a static cron string for provider wake output.")
    }
    return cron
  }
}

function findTypeParametersEnd(source: string, index: number): number {
  let depth = 0
  for (let cursor = index; cursor < source.length; cursor += 1) {
    const char = source[cursor]
    if (char === "<") depth += 1
    if (char === ">" && source[cursor - 1] === "=") continue
    if (char === ">") {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return -1
}

function readDefineScheduleObjectAfterDefault(source: string, index: number): string | undefined {
  let cursor = skipIgnorable(source, index)
  let openParens = 0
  while (source[cursor] === "(") {
    openParens += 1
    cursor = skipIgnorable(source, cursor + 1)
  }

  if (!source.startsWith("defineSchedule", cursor)) return undefined
  cursor += "defineSchedule".length

  cursor = skipIgnorable(source, cursor)
  if (source[cursor] === "<") {
    const close = findTypeParametersEnd(source, cursor)
    if (close === -1) return undefined
    cursor = skipIgnorable(source, close + 1)
  }

  if (source[cursor] !== "(") return undefined
  cursor = skipIgnorable(source, cursor + 1)
  const objectSource = readBalancedObject(source, cursor)
  if (!objectSource) return undefined

  let afterObject = skipIgnorable(source, cursor + objectSource.length + 2)
  if (source[afterObject] === ")") afterObject = skipIgnorable(source, afterObject + 1)
  while (openParens > 0 && source[afterObject] === ")") {
    openParens -= 1
    afterObject = skipIgnorable(source, afterObject + 1)
  }
  return openParens === 0 ? objectSource : undefined
}

function readDefaultDefineScheduleCron(source: string): string | undefined {
  let match: RegExpExecArray | null
  const pattern = /\bexport\s+default\b/g
  while ((match = pattern.exec(source))) {
    if (isInsideNonCode(source, match.index)) continue

    const objectSource = readDefineScheduleObjectAfterDefault(source, match.index + match[0].length)
    if (!objectSource) continue
    return readTopLevelCronProperty(objectSource)
  }
}

function renderProviderEntry(file: string, registryFile: string, provider: "cloudflare" | "vercel", scheduleName?: string) {
  const runtimeImport = createImportPath(file, scheduleRuntimeEntry)
  return [
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { executeStaticSchedule } from ${JSON.stringify(runtimeImport)}`,
    "",
    "async function loadScheduleDefinition(name) {",
    "  const loader = scheduleRegistry[name]",
    "  if (!loader) return undefined",
    "  const loaded = await loader()",
    "  return loaded?.default ?? loaded",
    "}",
    "",
    "async function runSchedule(name, cron, scheduledAt) {",
    "  const definition = await loadScheduleDefinition(name)",
    "  if (!definition) {",
    "    throw new Error(`Missing schedule definition: ${name}`)",
    "  }",
    "  return await executeStaticSchedule({ cron, definition, name, scheduledAt })",
    "}",
    "",
    provider === "cloudflare"
      ? [
          "export default {",
          "  async fetch() {",
          "    return new Response('ViteHub schedule provider wake endpoint')",
          "  },",
          "  async scheduled(event, env, ctx) {",
          "    const tasks = Object.entries(scheduleRegistry).map(async ([name]) => {",
          "      const definition = await loadScheduleDefinition(name)",
          "      if (!definition || definition.cron !== event.cron) return",
          "      await executeStaticSchedule({ cron: event.cron, definition, name, scheduledAt: new Date(event.scheduledTime) })",
          "    })",
          "    await Promise.all(tasks)",
          "  },",
          "}",
        ].join("\n")
      : [
          "export default async function scheduleHandler(req, res) {",
          "  const cronSecret = process.env.CRON_SECRET",
          "  const authorization = req.headers?.authorization || req.headers?.Authorization",
          "  if (cronSecret && authorization !== `Bearer ${cronSecret}`) {",
          "    res.statusCode = 401",
          "    res.end('Unauthorized.')",
          "    return",
          "  }",
          "  const url = new URL(req.url || '/', 'https://vitehub.local')",
          "  const prefix = '/api/vitehub/schedules/vercel/'",
          scheduleName === undefined
            ? "  const name = decodeURIComponent(url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '')"
            : `  const name = ${JSON.stringify(scheduleName)}`,
          "  const definition = await loadScheduleDefinition(name)",
          "  if (!definition) {",
          "    res.statusCode = 404",
          "    res.end('Missing schedule definition.')",
          "    return",
          "  }",
          "  await runSchedule(name, definition.cron, new Date())",
          "  res.statusCode = 204",
          "  res.end()",
          "}",
        ].join("\n"),
    "",
  ].join("\n")
}

function renderNetlifyScheduleFunction(file: string, registryFile: string, scheduleName: string, cron: string) {
  const runtimeImport = createImportPath(file, scheduleRuntimeEntry)
  return [
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { executeStaticSchedule } from ${JSON.stringify(runtimeImport)}`,
    "",
    `const scheduleName = ${JSON.stringify(scheduleName)}`,
    "",
    "export default async function netlifyScheduleHandler(request) {",
    "  const loaded = await scheduleRegistry[scheduleName]?.()",
    "  const definition = loaded?.default ?? loaded",
    "  if (!definition) return new Response('Missing schedule definition.', { status: 404 })",
    `  await executeStaticSchedule({ cron: ${JSON.stringify(cron)}, definition, name: scheduleName, scheduledAt: new Date() })`,
    "  return new Response(null, { status: 204 })",
    "}",
    "",
    "export const config = {",
    `  schedule: ${JSON.stringify(cron)},`,
    "}",
    "",
  ].join("\n")
}

function sanitizeNetlifyScheduleFunctionName(name: string): string {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
  return `vitehub-schedule-${safeName || "schedule"}.mjs`
}

function renderDenoCronEntry(file: string, registryFile: string, crons: Map<string, string>, runtimeImport = scheduleStaticRuntimeImport) {
  const scheduleCrons = Object.fromEntries([...crons.entries()].sort(([left], [right]) => left.localeCompare(right)))
  return [
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { executeStaticSchedule } from ${JSON.stringify(runtimeImport)}`,
    "",
    `const scheduleCrons = ${JSON.stringify(scheduleCrons, null, 2)}`,
    "",
    "async function loadScheduleDefinition(name) {",
    "  const loader = scheduleRegistry[name]",
    "  if (!loader) return undefined",
    "  const loaded = await loader()",
    "  return loaded?.default ?? loaded",
    "}",
    "",
    "for (const [name, cron] of Object.entries(scheduleCrons)) {",
    "  Deno.cron(`vitehub:${name}`, cron, async () => {",
    "    const definition = await loadScheduleDefinition(name)",
    "    if (!definition) {",
    "      throw new Error(`Missing schedule definition: ${name}`)",
    "    }",
    "    await executeStaticSchedule({ cron, definition, name, scheduledAt: new Date() })",
    "  })",
    "}",
    "",
    "export const vitehubScheduleDefinitions = Object.keys(scheduleCrons)",
    "",
  ].join("\n")
}

function createScheduleDefinitionAliasPlugin(): Plugin {
  return {
    name: "vitehub-schedule-definition-alias",
    setup(build) {
      build.onResolve({ filter: /^@vite-hub\/schedule$/ }, () => ({
        path: scheduleDefinitionEntry,
      }))
    },
  }
}

async function writeProviderEntries(
  rootDir: string,
  source?: DiscoveredScheduleDefinition["source"],
  providedDefinitions?: DiscoveredScheduleDefinition[],
): Promise<GeneratedScheduleArtifacts> {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = (providedDefinitions ?? discoverScheduleDefinitions({ rootDir }))
    .filter(definition => !source || definition.source === source)
    .filter(definition => definition.runtimeOnly !== true)
  await writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8")

  const cloudflareWorkerFile = resolve(generatedDir, "cloudflare-worker.mjs")
  const denoCronFile = resolve(generatedDir, denoCronFileName)
  const vercelServerFile = resolve(generatedDir, "vercel-server.mjs")
  await writeFile(cloudflareWorkerFile, renderProviderEntry(cloudflareWorkerFile, registryFile, "cloudflare"), "utf8")
  await writeFile(vercelServerFile, renderProviderEntry(vercelServerFile, registryFile, "vercel"), "utf8")

  return { cloudflareWorkerFile, denoCronFile, definitions, generatedDir, registryFile, vercelServerFile }
}

export async function readDefinitionCrons(definitions: DiscoveredScheduleDefinition[]) {
  const crons = new Map<string, string>()
  for (const definition of staticScheduleDefinitions(definitions)) {
    const cron = readStaticScheduleCron(definition.handler, definition.name)
    validateProviderCron(cron, definition.name)
    crons.set(definition.name, cron)
  }
  return crons
}

export async function writeVercelScheduleFunctions(options: {
  bundleAlias?: Record<string, string>
  definitions: DiscoveredScheduleDefinition[]
  outputRoot: string
  registryFile: string
  rootDir: string
}, crons: Map<string, string>) {
  const definitions = staticScheduleDefinitions(options.definitions)
  const outputRoot = options.outputRoot
  const functionRoot = resolve(outputRoot, "functions", "api", "vitehub", "schedules", "vercel")
  await rm(functionRoot, { force: true, recursive: true })

  const emittedFunctionNames = new Map<string, string>()
  for (const definition of definitions) {
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_").split("/").filter(Boolean).join("/")
    const existingName = emittedFunctionNames.get(safeName)
    if (existingName) {
      throw new Error(`Schedule "${definition.name}" and "${existingName}" both emit the same Vercel function path: ${safeName}`)
    }
    emittedFunctionNames.set(safeName, definition.name)

    const segments = safeName.split("/")
    const functionDir = resolve(functionRoot, ...segments.slice(0, -1), `${segments.at(-1)}.func`)
    const functionFile = resolve(functionDir, "index.mjs")
    const wrapperFile = resolve(functionDir, "index.source.mjs")
    await mkdir(functionDir, { recursive: true })
    await writeFile(wrapperFile, renderProviderEntry(wrapperFile, options.registryFile, "vercel", definition.name), "utf8")
    await bundleEsmEntry(wrapperFile, functionFile, {
      alias: options.bundleAlias,
      format: "esm",
      platform: "node",
      plugins: [createScheduleDefinitionAliasPlugin()],
    })
    await rm(wrapperFile, { force: true })
    await writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8")
  }

  const configFile = resolve(outputRoot, "config.json")
  let vercelConfig: ReturnType<typeof createVercelConfigJson> & { crons?: Array<{ path: string, schedule: string }> }
  try {
    vercelConfig = JSON.parse(await readFile(configFile, "utf8"))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    if (!definitions.length) {
      await removeEmptyDirectories(functionRoot, options.rootDir)
      return
    }
    vercelConfig = createVercelConfigJson()
  }
  const schedulePathPrefix = "/api/vitehub/schedules/vercel/"
  const previousCrons = vercelConfig.crons ?? []
  const existingCrons = previousCrons.filter(cron => !cron.path.startsWith(schedulePathPrefix))
  if (!definitions.length && existingCrons.length === previousCrons.length) {
    await removeEmptyDirectories(functionRoot, options.rootDir)
    return
  }
  const nextCrons = [...existingCrons, ...definitions.map(definition => ({
    path: getVercelSchedulePath(definition.name),
    schedule: crons.get(definition.name)!,
  }))]
  if (nextCrons.length) {
    vercelConfig.crons = nextCrons
  }
  else {
    delete vercelConfig.crons
  }
  if (!definitions.length) {
    await removeEmptyDirectories(functionRoot, options.rootDir)
    const outputFiles = await readdir(outputRoot)
    if (outputFiles.length === 1 && outputFiles[0] === "config.json" && isDeepStrictEqual(vercelConfig, createVercelConfigJson())) {
      await rm(configFile, { force: true })
      await removeEmptyDirectories(outputRoot, options.rootDir)
      return
    }
  }
  await writeFile(configFile, `${JSON.stringify(vercelConfig, null, 2)}\n`, "utf8")
}

export async function createNetlifyScheduleFunctionOutputs(options: {
  definitions: DiscoveredScheduleDefinition[]
  functionRoot: string
  registryFile: string
}): Promise<NetlifyScheduleFunctionOutput[]> {
  const definitions = staticScheduleDefinitions(options.definitions)
  const crons = await readDefinitionCrons(definitions)
  const emitted = new Map<string, string>()
  return definitions.map((definition) => {
    const fileName = sanitizeNetlifyScheduleFunctionName(definition.name)
    const existingName = emitted.get(fileName)
    if (existingName) {
      throw new Error(`Schedule "${definition.name}" and "${existingName}" both emit the same Netlify function file: ${fileName}`)
    }
    emitted.set(fileName, definition.name)
    const file = resolve(options.functionRoot, fileName)
    return {
      cron: crons.get(definition.name)!,
      file,
      name: definition.name,
      source: renderNetlifyScheduleFunction(file, options.registryFile, definition.name, crons.get(definition.name)!),
    }
  })
}

async function writeNetlifyScheduleFunctions(options: {
  definitions: DiscoveredScheduleDefinition[]
  outputRoot: string
  registryFile: string
  rootDir: string
}) {
  const functionRoot = resolve(options.outputRoot, "functions")
  const existingFiles = await readdir(functionRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  await Promise.all(existingFiles
    .filter(file => /^vitehub-schedule-.+\.mjs$/.test(file))
    .map(file => rm(resolve(functionRoot, file), { force: true, recursive: true })))

  const outputs = await createNetlifyScheduleFunctionOutputs({
    definitions: options.definitions,
    functionRoot,
    registryFile: options.registryFile,
  })
  if (outputs.length === 0) {
    await removeEmptyDirectories(functionRoot, options.rootDir)
    return
  }

  await mkdir(functionRoot, { recursive: true })
  await Promise.all(outputs.map(async output => writeFile(output.file, output.source, "utf8")))
}

async function writeCloudflareScheduleOutput(options: {
  bundleAlias?: Record<string, string>
  bundleEntry: string
  crons: string[]
  rootDir: string
  stateFile: string
}) {
  const outputRoot = createDefaultCloudflareOutputRoot(options.rootDir)
  await mkdir(outputRoot, { recursive: true })

  const configFile = resolve(outputRoot, "wrangler.json")
  let wranglerConfig: Record<string, unknown> = {}
  try {
    wranglerConfig = JSON.parse(await readFile(configFile, "utf8"))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const existingTriggers = typeof wranglerConfig.triggers === "object" && wranglerConfig.triggers !== null
    ? wranglerConfig.triggers as { crons?: string[] }
    : {}
  const previousState = await readCloudflareOutputState(options.stateFile)
  const externalCrons = (existingTriggers.crons ?? []).filter(cron => !previousState?.crons.includes(cron))
  const ownedCrons = options.crons.filter(cron => !externalCrons.includes(cron))
  const main = typeof wranglerConfig.main === "string" && wranglerConfig.main
    ? wranglerConfig.main
    : "index.js"
  wranglerConfig = {
    ...wranglerConfig,
    compatibility_date: wranglerConfig.compatibility_date ?? defaultCloudflareCompatibilityDate,
    compatibility_flags: wranglerConfig.compatibility_flags ?? ["nodejs_compat"],
    main,
    observability: wranglerConfig.observability ?? { enabled: true },
    triggers: {
      ...existingTriggers,
      crons: [...new Set([...externalCrons, ...options.crons])],
    },
  }

  await Promise.all([
    bundleEsmEntry(options.bundleEntry, resolve(outputRoot, main), {
      alias: options.bundleAlias,
      conditions: ["workerd", "worker", "browser", "default"],
      format: "esm",
      platform: "neutral",
      plugins: [createScheduleDefinitionAliasPlugin()],
    }),
    writeFile(configFile, `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8"),
    writeFile(options.stateFile, `${JSON.stringify({ crons: ownedCrons, main }, null, 2)}\n`, "utf8"),
  ])
}

interface CloudflareOutputState {
  crons: string[]
  main: string
}

async function readCloudflareOutputState(file: string): Promise<CloudflareOutputState | undefined> {
  let source: string
  try {
    source = await readFile(file, "utf8")
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  try {
    const state = JSON.parse(source) as Partial<CloudflareOutputState>
    if (!Array.isArray(state.crons) || state.crons.some(cron => typeof cron !== "string") || typeof state.main !== "string" || !state.main) return
    return { crons: state.crons, main: state.main }
  }
  catch {
    return
  }
}

async function cleanCloudflareScheduleOutput(rootDir: string, stateFile: string): Promise<void> {
  const state = await readCloudflareOutputState(stateFile)
  if (!state) return
  const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
  const configFile = resolve(outputRoot, "wrangler.json")
  let configSource: string | undefined
  try {
    configSource = await readFile(configFile, "utf8")
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  if (configSource !== undefined) {
    const config = JSON.parse(configSource) as Record<string, unknown>
    const triggers = typeof config.triggers === "object" && config.triggers !== null
      ? config.triggers as Record<string, unknown>
      : undefined
    const crons = Array.isArray(triggers?.crons)
      ? triggers.crons.filter((cron): cron is string => typeof cron === "string" && !state.crons.includes(cron))
      : []
    if (triggers) {
      config.triggers = { ...triggers, crons }
    }
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  }
  await Promise.all([
    rm(resolve(outputRoot, state.main), { force: true }),
    rm(stateFile, { force: true }),
  ])
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedScheduleArtifacts> {
  const generatedDir = ensureGeneratedDir(options.rootDir, productName)
  const cloudflareStateFile = resolve(generatedDir, cloudflareOutputStateFileName)
  const artifacts = await writeProviderEntries(options.rootDir, options.source, options.definitions)
  const crons = await readDefinitionCrons(artifacts.definitions)
  if (artifacts.definitions.length > 0) {
    await writeFile(artifacts.denoCronFile, renderDenoCronEntry(artifacts.denoCronFile, artifacts.registryFile, crons, options.runtimeImport), "utf8")
    await writeCloudflareScheduleOutput({
      bundleAlias: options.bundleAlias,
      bundleEntry: artifacts.cloudflareWorkerFile,
      crons: [...new Set(crons.values())],
      rootDir: options.rootDir,
      stateFile: cloudflareStateFile,
    })
  }
  else {
    await Promise.all([
      rm(artifacts.cloudflareWorkerFile, { force: true }),
      rm(artifacts.denoCronFile, { force: true }),
      rm(artifacts.registryFile, { force: true }),
      rm(artifacts.vercelServerFile, { force: true }),
      cleanCloudflareScheduleOutput(options.rootDir, cloudflareStateFile),
    ])
  }
  await writeVercelScheduleFunctions({
    bundleAlias: options.bundleAlias,
    definitions: artifacts.definitions,
    outputRoot: createDefaultVercelOutputRoot(options.rootDir),
    registryFile: artifacts.registryFile,
    rootDir: options.rootDir,
  }, crons)
  await writeNetlifyScheduleFunctions({
    definitions: artifacts.definitions,
    outputRoot: createDefaultNetlifyOutputRoot(options.rootDir),
    registryFile: artifacts.registryFile,
    rootDir: options.rootDir,
  })
  return artifacts
}
