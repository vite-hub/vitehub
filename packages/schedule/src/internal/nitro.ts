import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"

import { getScheduleTaskName } from "../runtime/static.ts"

import type { DiscoveredScheduleDefinition } from "../types.ts"

export const schedulePackageName = "@vite-hub/schedule"
export const generatedNitroScheduleDir = ".vitehub/nitro/schedule"
/** Netlify scheduled functions call this Nitro route. Nitro has no Netlify scheduler. */
export const netlifyScheduleRoute = "/_vitehub/schedules/run"
const scheduleModuleName = "vitehub:schedule"

export interface ScheduleEntry {
  cron: string
  name: string
}

interface ScheduleNitroFiles {
  denoPlugin: string
  netlifyHandler: string
  task: string
}

interface ScheduleNitroTarget {
  hooks: { hook: (name: "compiled", handler: () => Promise<void>) => unknown }
  options: {
    experimental: Record<string, unknown>
    handlers: Array<Record<string, unknown>>
    plugins: string[]
    preset?: string
    rootDir: string
    scheduledTasks?: Record<string, string | string[]>
    tasks?: Record<string, { description?: string, handler?: string }>
  }
}

export interface ScheduleNitroModule {
  name: string
  setup: (nitro: ScheduleNitroTarget) => void
}

function renderTask(registryFile: string, runtimeImport: string): string {
  return [
    `import scheduleRegistry from ${JSON.stringify(`./${registryFile}`)}`,
    `import { runScheduleTask } from ${JSON.stringify(runtimeImport)}`,
    "",
    "export default {",
    "  meta: { description: \"Runs a ViteHub Static Schedule Definition.\" },",
    "  run: event => runScheduleTask(event, scheduleRegistry),",
    "}",
    "",
  ].join("\n")
}

function renderNetlifyHandler(registryFile: string, runtimeImport: string, entries: ScheduleEntry[], buildSecret: string): string {
  return [
    `import { defineHandler } from "nitro"`,
    `import scheduleRegistry from ${JSON.stringify(`./${registryFile}`)}`,
    `import { getScheduleTaskName, isScheduleCronAuthorized, runScheduleTask } from ${JSON.stringify(runtimeImport)}`,
    "",
    `const schedules = new Set(${JSON.stringify(entries.map(entry => entry.name))})`,
    "",
    "export default defineHandler(async (event) => {",
    `  const secret = process.env.CRON_SECRET || ${JSON.stringify(buildSecret)}`,
    "  if (!isScheduleCronAuthorized(event.req.headers.get(\"authorization\"), secret)) return new Response(\"Unauthorized.\", { status: 401 })",
    "  const name = event.req.headers.get(\"x-vitehub-schedule\") || \"\"",
    "  if (!schedules.has(name)) return new Response(\"Unknown Schedule.\", { status: 404 })",
    "  const waitUntil = event.req.waitUntil?.bind(event.req)",
    "  await runScheduleTask({ context: { waitUntil }, name: getScheduleTaskName(name) }, scheduleRegistry)",
    "  return new Response(null, { status: 204 })",
    "})",
    "",
  ].join("\n")
}

function renderNetlifyFunction(entry: ScheduleEntry, buildSecret: string): string {
  return [
    "export default async function vitehubScheduleWake() {",
    `  const response = await fetch(new URL(${JSON.stringify(netlifyScheduleRoute)}, process.env.URL), {`,
    "    method: \"POST\",",
    `    headers: { authorization: \`Bearer \${process.env.CRON_SECRET || ${JSON.stringify(buildSecret)}}\`, "x-vitehub-schedule": ${JSON.stringify(entry.name)} },`,
    "  })",
    `  if (!response.ok) throw new Error(\`ViteHub Schedule ${entry.name.replaceAll("`", "")} failed with HTTP \${response.status}.\`)`,
    "}",
    "",
    `export const config = { schedule: ${JSON.stringify(entry.cron)} }`,
    "",
  ].join("\n")
}

function netlifyFunctionFile(name: string): string {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "")
  return `vitehub-schedule-${safeName || "schedule"}.mjs`
}

function renderDenoPlugin(registryFile: string, runtimeImport: string, entries: ScheduleEntry[]): string {
  const crons = [...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ cron, name }, index) => {
      const prefix = `vitehub-${index.toString(36)}-`
      const safeName = [...name].map(character => /^[a-z0-9 _-]$/i.test(character) ? character : "_").join("")
      return { cron, cronName: `${prefix}${safeName.slice(0, 64 - prefix.length)}`, name }
    })
  return [
    `import { definePlugin } from "nitro"`,
    `import scheduleRegistry from ${JSON.stringify(`./${registryFile}`)}`,
    `import { getScheduleTaskName, runScheduleTask } from ${JSON.stringify(runtimeImport)}`,
    "",
    `const crons = ${JSON.stringify(crons, null, 2)}`,
    "",
    "// Deno Deploy reads `Deno.cron` calls during startup. Nitro runs plugins when the server module loads.",
    "export default definePlugin(() => {",
    "  for (const { cron, cronName, name } of crons) {",
    "    Deno.cron(cronName, cron, async () => {",
    "      await runScheduleTask({ name: getScheduleTaskName(name) }, scheduleRegistry)",
    "    })",
    "  }",
    "})",
    "",
  ].join("\n")
}

async function writeScheduleNitroFiles(projectRoot: string, definitions: DiscoveredScheduleDefinition[], entries: ScheduleEntry[], runtimeImport: string, buildSecret: string): Promise<ScheduleNitroFiles> {
  const directory = resolve(projectRoot, generatedNitroScheduleDir)
  await mkdir(directory, { recursive: true })
  const registryFileName = "registry.js"
  const files = {
    denoPlugin: join(directory, "deno-cron.mjs"),
    netlifyHandler: join(directory, "netlify-handler.mjs"),
    task: join(directory, "task.mjs"),
  }
  const registryFile = join(directory, registryFileName)
  await Promise.all([
    writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8"),
    writeFile(files.task, renderTask(registryFileName, runtimeImport), "utf8"),
    writeFile(files.netlifyHandler, renderNetlifyHandler(registryFileName, runtimeImport, entries, buildSecret), "utf8"),
    writeFile(files.denoPlugin, renderDenoPlugin(registryFileName, runtimeImport, entries), "utf8"),
    // The standalone writer used `.vitehub/schedule`. A stale Deno cron entry there would run every Schedule twice.
    rm(resolve(projectRoot, ".vitehub/schedule"), { force: true, recursive: true }),
  ])
  return files
}

function defineScheduleNitroModule(entries: ScheduleEntry[], files: ScheduleNitroFiles, buildSecret: string): ScheduleNitroModule {
  return {
    name: scheduleModuleName,
    setup(nitro) {
      const options = nitro.options
      options.experimental.tasks = true
      options.tasks ??= {}
      options.scheduledTasks ??= {}
      for (const { cron, name } of entries) {
        const task = getScheduleTaskName(name)
        options.tasks[task] = { description: `ViteHub Static Schedule "${name}" (${cron} UTC).`, handler: files.task }
        const current = options.scheduledTasks[cron]
        const tasks = current === undefined ? [] : Array.isArray(current) ? current : [current]
        if (!tasks.includes(task)) options.scheduledTasks[cron] = [...tasks, task]
      }
      const preset = (options.preset ?? "").replaceAll("_", "-")
      if (preset === "netlify") {
        options.handlers.push({ handler: files.netlifyHandler, method: "POST", route: netlifyScheduleRoute })
        nitro.hooks.hook("compiled", async () => {
          const directory = resolve(options.rootDir, ".netlify/v1/functions")
          await mkdir(directory, { recursive: true })
          await Promise.all(entries.map(entry => writeFile(join(directory, netlifyFunctionFile(entry.name)), renderNetlifyFunction(entry, buildSecret), "utf8")))
        })
      }
      if (preset === "deno-deploy") options.plugins.push(files.denoPlugin)
    },
  }
}

export interface ScheduleNitroModuleOptions {
  definitions: DiscoveredScheduleDefinition[]
  entries: ScheduleEntry[]
  projectRoot: string
  runtimeImport: string
}

/**
 * Writes the Schedule task and the host files, and returns the Nitro module that registers
 * each Static Schedule as a Nitro task in `scheduledTasks`.
 */
// One build resolves the Nitro config more than once. The Netlify function and the Nitro route must share one secret.
const buildSecrets = new Map<string, string>()

export async function createScheduleNitroModule(options: ScheduleNitroModuleOptions): Promise<ScheduleNitroModule> {
  const buildSecret = buildSecrets.get(options.projectRoot) ?? randomUUID()
  buildSecrets.set(options.projectRoot, buildSecret)
  const files = await writeScheduleNitroFiles(options.projectRoot, options.definitions, options.entries, options.runtimeImport, buildSecret)
  return defineScheduleNitroModule(options.entries, files, buildSecret)
}

export function isScheduleNitroModule(value: unknown): boolean {
  return Object(value) === value && Reflect.get(Object(value), "name") === scheduleModuleName
}
