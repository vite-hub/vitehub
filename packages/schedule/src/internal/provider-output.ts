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
import { findIdentifierCalls } from "@vitehub/internal/source-scanner"

import { discoverScheduleDefinitions } from "../discovery.ts"
import { getVercelSchedulePath } from "../integrations/vercel.ts"

import type { DiscoveredScheduleDefinition } from "../types.ts"

export const schedulePackageName = "@vitehub/schedule"
const productName = "schedule"
const generatedRegistryFileName = "registry.mjs"

export function resolveScheduleRuntimeEntry(metaUrl = import.meta.url) {
  return metaUrl.includes("/src/")
    ? resolve(dirname(fileURLToPath(metaUrl)), "../runtime/execute.ts")
    : resolve(dirname(fileURLToPath(metaUrl)), "../runtime/execute.js")
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
  clientOutDir: string
  rootDir: string
}

const cronFieldPattern = /^[*,/\-0-9]+$/

function readStringLiteral(source: string): string | undefined {
  const quote = source.trim()[0]
  if (quote !== "\"" && quote !== "'" && quote !== "`") return undefined
  const trimmed = source.trim()
  let value = ""
  for (let index = 1; index < trimmed.length; index++) {
    const char = trimmed[index]
    if (char === "\\") {
      value += trimmed[index + 1] ?? ""
      index++
      continue
    }
    if (char === quote) {
      if (trimmed.slice(index + 1).trim()) return undefined
      if (quote === "`" && value.includes("${")) return undefined
      return value
    }
    value += char
  }
}

export function validateProviderCron(cron: string, scheduleName: string): void {
  const fields = cron.trim().split(/\s+/)
  const hasVercelDayConflict = fields[2] !== "*" && fields[4] !== "*"
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field)) || hasVercelDayConflict) {
    throw new Error(`Schedule "${scheduleName}" uses cron "${cron}", but provider wake output only supports five-field UTC cron syntax compatible with Cloudflare and Vercel.`)
  }
}

function readStaticScheduleCron(file: string, scheduleName: string): string {
  const source = readFileSync(file, "utf8")
  const args = findIdentifierCalls(source, "defineSchedule")[0]?.arguments ?? []
  const cron = (args[0] ? readStringLiteral(args[0]) : undefined)
    ?? source.match(/\bexport\s+default\s*\{[\s\S]*?\bcron\s*:\s*(["'`])([^"'`]+)\1/)?.[2]
  if (!cron) {
    throw new Error(`Schedule "${scheduleName}" must declare a static cron string for provider wake output.`)
  }
  return cron
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
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_")
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
  wranglerConfig = {
    ...wranglerConfig,
    compatibility_date: wranglerConfig.compatibility_date ?? defaultCloudflareCompatibilityDate,
    compatibility_flags: wranglerConfig.compatibility_flags ?? ["nodejs_compat"],
    main: wranglerConfig.main ?? "index.js",
    observability: wranglerConfig.observability ?? { enabled: true },
    triggers: {
      ...existingTriggers,
      crons: [...new Set([...(existingTriggers.crons ?? []), ...options.crons])],
    },
  }

  await Promise.all([
    bundleEsmEntry(options.bundleEntry, resolve(outputRoot, "index.js"), {
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
    bundleEntry: artifacts.cloudflareWorkerFile,
    crons: [...new Set(crons.values())],
    rootDir: options.rootDir,
  })
  await writeVercelScheduleFunctions({
    definitions: artifacts.definitions,
    outputRoot: createDefaultVercelOutputRoot(options.rootDir),
    registryFile: artifacts.registryFile,
    rootDir: options.rootDir,
  }, crons)
  return artifacts
}
