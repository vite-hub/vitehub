import { readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { defaultCloudflareCompatibilityDate } from "@vitehub/internal/build/cloudflare"
import { createDefaultVercelOutputRoot, writeProviderDeploymentOutputs } from "@vitehub/internal/build/deployment-output"
import { bundleEsmEntry } from "@vitehub/internal/build/esbuild"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vitehub/internal/build/paths"
import { createNodeFunctionConfig, createVercelConfigJson } from "@vitehub/internal/build/vercel-config"
import { createRuntimeRegistryContents } from "@vitehub/internal/definition-catalog"

import { discoverScheduleDefinitions } from "../discovery.ts"
import { getVercelSchedulePath } from "../integrations/vercel.ts"

import type { DiscoveredScheduleDefinition } from "../types.ts"

export const schedulePackageName = "@vitehub/schedule"
const productName = "schedule"
const generatedRegistryFileName = "registry.mjs"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

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

const cronFieldPattern = /^[*,/\-0-9A-Za-z]+$/

export function validateProviderCron(cron: string, scheduleName: string): void {
  const fields = cron.split(/\s+/)
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field))) {
    throw new Error(`Schedule "${scheduleName}" uses cron "${cron}", but provider wake output only supports five-field UTC cron syntax compatible with Cloudflare and Vercel.`)
  }
}

function readStaticScheduleCron(file: string, scheduleName: string): string {
  const source = readFileSync(file, "utf8")
  const match = source.match(/\bdefineSchedule\s*(?:<[^>]+>\s*)?\(\s*(["'`])([^"'`]+)\1/)
    ?? source.match(/\bcron\s*:\s*(["'`])([^"'`]+)\1/)
  if (!match?.[2]) {
    throw new Error(`Schedule "${scheduleName}" must declare a static cron string for provider wake output.`)
  }
  return match[2]
}

function renderProviderEntry(file: string, registryFile: string, provider: "cloudflare" | "vercel") {
  const runtimeImport = createImportPath(file, resolveRuntimeModule("runtime/execute"))
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
          "  const name = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '')",
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
  definitions: DiscoveredScheduleDefinition[]
  outputRoot: string
  registryFile: string
  rootDir: string
}, crons: Map<string, string>) {
  const outputRoot = options.outputRoot
  const functionRoot = resolve(outputRoot, "functions", "api", "vitehub", "schedules", "vercel")
  await rm(functionRoot, { force: true, recursive: true })

  for (const definition of options.definitions) {
    const safeName = definition.name.replace(/[^a-z0-9/_-]+/gi, "_")
    const segments = safeName.split("/")
    const functionDir = resolve(functionRoot, ...segments.slice(0, -1), `${segments.at(-1)}.func`)
    const functionFile = resolve(functionDir, "index.mjs")
    const wrapperFile = resolve(functionDir, "index.source.mjs")
    await mkdir(functionDir, { recursive: true })
    await writeFile(wrapperFile, renderProviderEntry(wrapperFile, options.registryFile, "vercel"), "utf8")
    await bundleEsmEntry(wrapperFile, functionFile, { format: "esm", platform: "node" })
    await rm(wrapperFile, { force: true })
    await writeFile(resolve(functionDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8")
  }

  const vercelConfig = createVercelConfigJson() as ReturnType<typeof createVercelConfigJson> & { crons?: Array<{ path: string, schedule: string }> }
  vercelConfig.crons = options.definitions.map(definition => ({
    path: getVercelSchedulePath(definition.name),
    schedule: crons.get(definition.name)!,
  }))
  await writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(vercelConfig, null, 2)}\n`, "utf8")
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedScheduleArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir)
  const crons = await readDefinitionCrons(artifacts.definitions)
  await writeProviderDeploymentOutputs({
    clientOutDir: options.clientOutDir,
    cloudflare: {
      bundleEntry: artifacts.cloudflareWorkerFile,
      bundleOptions: {
        conditions: ["workerd", "worker", "browser", "default"],
        format: "esm",
        platform: "neutral",
      },
      wranglerConfig: {
        compatibility_date: defaultCloudflareCompatibilityDate,
        compatibility_flags: ["nodejs_compat"],
        main: "index.js",
        observability: { enabled: true },
        triggers: { crons: [...new Set(crons.values())] },
      },
    },
    rootDir: options.rootDir,
    vercel: {
      bundleEntry: artifacts.vercelServerFile,
      bundleOptions: { format: "esm", platform: "node" },
      config: createVercelConfigJson(),
    },
  })
  await writeVercelScheduleFunctions({
    definitions: artifacts.definitions,
    outputRoot: createDefaultVercelOutputRoot(options.rootDir),
    registryFile: artifacts.registryFile,
    rootDir: options.rootDir,
  }, crons)
  return artifacts
}
