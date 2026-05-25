import { readFileSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defaultCloudflareCompatibilityDate } from "@vitehub/internal/build/cloudflare"
import { createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot } from "@vitehub/internal/build/deployment-output"
import { bundleEsmEntry } from "@vitehub/internal/build/esbuild"
import { createImportPath, ensureGeneratedDir } from "@vitehub/internal/build/paths"
import { createNodeFunctionConfig, createVercelConfigJson } from "@vitehub/internal/build/vercel-config"
import { createRuntimeRegistryContents } from "@vitehub/internal/definition-catalog"

import { discoverScheduleDefinitions } from "../discovery.ts"
import { getVercelSchedulePath } from "../integrations/vercel.ts"

import type { DiscoveredScheduleDefinition } from "../types.ts"

export const schedulePackageName = "@vitehub/schedule"
const productName = "schedule"
const generatedRegistryFileName = "registry.mjs"

export function resolveScheduleRuntimeEntry(metaUrl = import.meta.url) {
  const file = fileURLToPath(metaUrl)
  const normalizedFile = file.replace(/\\/g, "/")
  return normalizedFile.endsWith("/src/internal/provider-output.ts")
    ? resolve(dirname(file), "../runtime/execute.ts")
    : resolve(dirname(file), "../runtime/execute.js")
}

const scheduleRuntimeEntry = resolveScheduleRuntimeEntry()

interface GeneratedScheduleArtifacts {
  cloudflareWorkerFile: string
  definitions: DiscoveredScheduleDefinition[]
  generatedDir: string
  registryFile: string
  vercelServerFile: string
}

interface GenerateProviderOutputsOptions {
  bundleAlias?: Record<string, string>
  clientOutDir: string
  rootDir: string
}

const cronFieldPattern = /^[*,/\-0-9]+$/

export function validateProviderCron(cron: string, scheduleName: string): void {
  const fields = cron.trim().split(/\s+/)
  const hasVercelDayConflict = fields[2] !== "*" && fields[4] !== "*"
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field)) || hasVercelDayConflict) {
    throw new Error(`Schedule "${scheduleName}" uses cron "${cron}", but provider wake output only supports five-field UTC cron syntax compatible with Cloudflare and Vercel.`)
  }
}

function readStaticScheduleCron(file: string, scheduleName: string): string {
  const source = readFileSync(file, "utf8")
  const cron = readDefaultDefineScheduleCron(source) ?? readDefaultObjectCron(source)
  if (!cron) {
    throw new Error(`Schedule "${scheduleName}" must declare a static cron string for provider wake output.`)
  }
  return cron
}

function skipQuoted(source: string, index: number): number {
  const quote = source[index]
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

function skipLineComment(source: string, index: number): number {
  const newline = source.indexOf("\n", index + 2)
  return newline === -1 ? source.length : newline + 1
}

function skipBlockComment(source: string, index: number): number {
  const close = source.indexOf("*/", index + 2)
  return close === -1 ? source.length : close + 2
}

function isInsideComment(source: string, targetIndex: number): boolean {
  for (let index = 0; index < targetIndex; index += 1) {
    const char = source[index]
    if (char === "\"" || char === "'" || char === "`") {
      index = skipQuoted(source, index) - 1
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
  return token === "" || token === "return" || token === "case" || token === "await" || /^[({[=,:;!&|?+\-*%^~<>]$/.test(token)
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

    const key = property.slice(0, colon).trim().replace(/^["'`](.*)["'`]$/s, "$1")
    if (key !== "cron") continue

    const cron = readStaticStringLiteral(property.slice(colon + 1))
    if (!cron) {
      throw new Error("Schedule must declare a static cron string for provider wake output.")
    }
    return cron
  }
}

function readDefaultDefineScheduleCron(source: string): string | undefined {
  let match: RegExpExecArray | null
  const pattern = /\bexport\s+default\s+defineSchedule\s*\(/g
  while ((match = pattern.exec(source))) {
    if (isInsideComment(source, match.index)) continue

    const objectStart = skipIgnorable(source, match.index + match[0].length)
    const objectSource = readBalancedObject(source, objectStart)
    return objectSource ? readTopLevelCronProperty(objectSource) : undefined
  }
}

function readDefaultObjectCron(source: string): string | undefined {
  const match = /\bexport\s+default\b/.exec(source)
  if (!match) return undefined

  const objectStart = skipIgnorable(source, match.index + match[0].length)
  const objectSource = readBalancedObject(source, objectStart)
  return objectSource ? readTopLevelCronProperty(objectSource) : undefined
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

async function writeProviderEntries(rootDir: string): Promise<GeneratedScheduleArtifacts> {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const definitions = discoverScheduleDefinitions({ rootDir })
  await writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8")

  const cloudflareWorkerFile = resolve(generatedDir, "cloudflare-worker.mjs")
  const vercelServerFile = resolve(generatedDir, "vercel-server.mjs")
  await writeFile(cloudflareWorkerFile, renderProviderEntry(cloudflareWorkerFile, registryFile, "cloudflare"), "utf8")
  await writeFile(vercelServerFile, renderProviderEntry(vercelServerFile, registryFile, "vercel"), "utf8")

  return { cloudflareWorkerFile, definitions, generatedDir, registryFile, vercelServerFile }
}

export async function readDefinitionCrons(definitions: DiscoveredScheduleDefinition[]) {
  const crons = new Map<string, string>()
  for (const definition of definitions) {
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
  const outputRoot = options.outputRoot
  const functionRoot = resolve(outputRoot, "functions", "api", "vitehub", "schedules", "vercel")
  await rm(functionRoot, { force: true, recursive: true })

  const emittedFunctionNames = new Map<string, string>()
  for (const definition of options.definitions) {
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
    await bundleEsmEntry(wrapperFile, functionFile, { alias: options.bundleAlias, format: "esm", platform: "node" })
    await rm(wrapperFile, { force: true })
    await writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8")
  }

  const configFile = resolve(outputRoot, "config.json")
  let vercelConfig = createVercelConfigJson() as ReturnType<typeof createVercelConfigJson> & { crons?: Array<{ path: string, schedule: string }> }
  try {
    vercelConfig = JSON.parse(await readFile(configFile, "utf8"))
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const schedulePathPrefix = "/api/vitehub/schedules/vercel/"
  const existingCrons = vercelConfig.crons?.filter(cron => !cron.path.startsWith(schedulePathPrefix)) ?? []
  vercelConfig.crons = [...existingCrons, ...options.definitions.map(definition => ({
    path: getVercelSchedulePath(definition.name),
    schedule: crons.get(definition.name)!,
  }))]
  await writeFile(configFile, `${JSON.stringify(vercelConfig, null, 2)}\n`, "utf8")
}

async function writeCloudflareScheduleOutput(options: {
  bundleAlias?: Record<string, string>
  bundleEntry: string
  crons: string[]
  rootDir: string
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
      crons: [...new Set([...(existingTriggers.crons ?? []), ...options.crons])],
    },
  }

  await Promise.all([
    bundleEsmEntry(options.bundleEntry, resolve(outputRoot, main), {
      alias: options.bundleAlias,
      conditions: ["workerd", "worker", "browser", "default"],
      format: "esm",
      platform: "neutral",
    }),
    writeFile(configFile, `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8"),
  ])
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedScheduleArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir)
  const crons = await readDefinitionCrons(artifacts.definitions)
  await writeCloudflareScheduleOutput({
    bundleAlias: options.bundleAlias,
    bundleEntry: artifacts.cloudflareWorkerFile,
    crons: [...new Set(crons.values())],
    rootDir: options.rootDir,
  })
  await writeVercelScheduleFunctions({
    bundleAlias: options.bundleAlias,
    definitions: artifacts.definitions,
    outputRoot: createDefaultVercelOutputRoot(options.rootDir),
    registryFile: artifacts.registryFile,
    rootDir: options.rootDir,
  }, crons)
  return artifacts
}
