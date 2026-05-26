import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { applyNitroRuntimeAliases, createNitroRuntimeFilePath, createRuntimeRegistryContents, hookNitroRuntimeRegistryRefresh, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { assertNoVitePluginInNitro, mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { discoverScheduleDefinitions } from "../discovery.ts"
import { readDefinitionCrons, writeVercelScheduleFunctions } from "../internal/provider-output.ts"
import { createScheduleTargetsContents, SCHEDULE_TARGETS_ID } from "../targets-module.ts"

import type { Nitro, NitroModule } from "nitro/types"

const SCHEDULE_NITRO_IMPORTS_PRESET = { from: "@vitehub/schedule", imports: ["defineSchedule"] }
const SCHEDULE_VITE_PLUGIN_NAME = "@vitehub/schedule/vite"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function createNitroScheduleRegistryPath(rootDir: string, buildDir: string) {
  return createNitroRuntimeFilePath(rootDir, {
    buildDir,
    fileName: "nitro-registry.mjs",
    segments: ["vitehub", "schedule"],
  })
}

function createNitroScheduleTargetsPath(rootDir: string, buildDir: string) {
  return createNitroRuntimeFilePath(rootDir, {
    buildDir,
    fileName: "targets.mjs",
    segments: ["vitehub", "schedule"],
  })
}

function createNitroSchedulePluginPath(rootDir: string, buildDir: string) {
  return createNitroRuntimeFilePath(rootDir, {
    buildDir,
    fileName: "nitro-plugin.ts",
    segments: ["vitehub", "schedule"],
  })
}

function resolveNitroScheduleScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, "server")]
}

function registerNitroSchedulePlugin(nitro: Nitro, pluginFile: string) {
  nitro.options.plugins ||= []
  if (!nitro.options.plugins.includes(pluginFile)) {
    nitro.options.plugins.push(pluginFile)
  }
}

function createNitroSchedulePluginContents(file: string, registryFile: string) {
  return [
    "import { definePlugin as defineNitroPlugin } from \"nitro\"",
    "",
    "import { executeStaticSchedule } from \"@vitehub/schedule\"",
    "import { setScheduleRuntimeRegistry } from \"@vitehub/schedule/runtime/state\"",
    "",
    `import scheduleRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    "",
    "async function loadScheduleDefinition(name: string) {",
    "  const loader = scheduleRegistry[name]",
    "  if (!loader) return undefined",
    "  const loaded = await loader()",
    "  return loaded?.default ?? loaded",
    "}",
    "",
    "const scheduleNitroPlugin = defineNitroPlugin((nitroApp: any) => {",
    "  setScheduleRuntimeRegistry(scheduleRegistry)",
    "  nitroApp.hooks.hook(\"cloudflare:scheduled\", async ({ event }: { event: { cron: string, scheduledTime: number } }) => {",
    "    await Promise.all(Object.keys(scheduleRegistry).map(async (name) => {",
    "      const definition = await loadScheduleDefinition(name)",
    "      if (!definition || definition.cron !== event.cron) return",
    "      await executeStaticSchedule({ cron: event.cron, definition, name, scheduledAt: new Date(event.scheduledTime) })",
    "    }))",
    "  })",
    "})",
    "",
    "export default scheduleNitroPlugin",
    "",
  ].join("\n")
}

async function writeNitroScheduleRuntimeFiles(nitro: Nitro): Promise<{ pluginFile: string, registryFile: string, targetsFile: string }> {
  const registryFile = createNitroScheduleRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const targetsFile = createNitroScheduleTargetsPath(nitro.options.rootDir, nitro.options.buildDir)
  const pluginFile = createNitroSchedulePluginPath(nitro.options.rootDir, nitro.options.buildDir)
  const definitions = discoverScheduleDefinitions({
    mode: "nitro-server-schedules",
    scanDirs: resolveNitroScheduleScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })

  await Promise.all([
    writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, definitions)),
    writeFileIfChanged(targetsFile, createScheduleTargetsContents(definitions)),
    writeFileIfChanged(pluginFile, createNitroSchedulePluginContents(pluginFile, registryFile)),
  ])

  return { pluginFile, registryFile, targetsFile }
}

const scheduleNitroModule: NitroModule = {
  name: "@vitehub/schedule",
  async setup(nitro) {
    await assertNoVitePluginInNitro(nitro, SCHEDULE_VITE_PLUGIN_NAME, "@vitehub/schedule/nitro")

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/schedule"] = resolveRuntimeEntry("../index", "@vitehub/schedule")
    nitro.options.alias["@vitehub/schedule/runtime"] = resolveRuntimeEntry("../runtime", "@vitehub/schedule/runtime")
    nitro.options.alias["@vitehub/schedule/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vitehub/schedule/runtime/state")

    let runtimeFiles = await writeNitroScheduleRuntimeFiles(nitro)
    applyNitroRuntimeAliases(nitro, {
      "#vitehub/schedule/registry": runtimeFiles.registryFile,
      [SCHEDULE_TARGETS_ID]: runtimeFiles.targetsFile,
    })

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, SCHEDULE_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
    }

    registerNitroSchedulePlugin(nitro, runtimeFiles.pluginFile)

    if (nitro.options.preset?.includes("cloudflare")) {
      const definitions = discoverScheduleDefinitions({
        mode: "nitro-server-schedules",
        scanDirs: resolveNitroScheduleScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
      })
      const crons = await readDefinitionCrons(definitions)
      if (crons.size) {
        nitro.options.cloudflare ||= {}
        nitro.options.cloudflare.wrangler ||= {}
        nitro.options.cloudflare.wrangler.triggers ||= { crons: [] }
        const existing = nitro.options.cloudflare.wrangler.triggers.crons || []
        nitro.options.cloudflare.wrangler.triggers.crons = [...new Set([...existing, ...crons.values()])]
      }
    }

    hookNitroRuntimeRegistryRefresh(nitro, () => writeNitroScheduleRuntimeFiles(nitro), (nextRuntimeFiles) => {
      runtimeFiles = nextRuntimeFiles
      applyNitroRuntimeAliases(nitro, {
        "#vitehub/schedule/registry": runtimeFiles.registryFile,
        [SCHEDULE_TARGETS_ID]: runtimeFiles.targetsFile,
      })
      registerNitroSchedulePlugin(nitro, runtimeFiles.pluginFile)
    })

    nitro.hooks.hook("compiled", async (currentNitro: Nitro) => {
      if (!currentNitro.options.preset?.includes("vercel")) {
        return
      }
      const definitions = discoverScheduleDefinitions({
        mode: "nitro-server-schedules",
        scanDirs: resolveNitroScheduleScanDirs(currentNitro.options.rootDir, currentNitro.options.scanDirs),
      })
      const crons = await readDefinitionCrons(definitions)
      await writeVercelScheduleFunctions({
        bundleAlias: currentNitro.options.alias,
        definitions,
        outputRoot: currentNitro.options.output.dir,
        registryFile: runtimeFiles.registryFile,
        rootDir: currentNitro.options.rootDir,
      }, crons)
    })
  },
}

export default scheduleNitroModule
