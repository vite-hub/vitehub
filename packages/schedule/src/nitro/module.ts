import { resolve } from "node:path"

import { applyNitroRuntimeAliases, createNitroRuntimeFilePath, createRuntimeRegistryContents, hookNitroRuntimeRegistryRefresh, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { assertNoVitePluginInNitro, mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { discoverScheduleDefinitions } from "../discovery.ts"
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

function resolveNitroScheduleScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, "server")]
}

async function writeNitroScheduleRuntimeFiles(nitro: Nitro): Promise<{ registryFile: string, targetsFile: string }> {
  const registryFile = createNitroScheduleRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const targetsFile = createNitroScheduleTargetsPath(nitro.options.rootDir, nitro.options.buildDir)
  const definitions = discoverScheduleDefinitions({
    mode: "nitro-server-schedules",
    scanDirs: resolveNitroScheduleScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })

  await Promise.all([
    writeFileIfChanged(registryFile, createRuntimeRegistryContents(registryFile, definitions)),
    writeFileIfChanged(targetsFile, createScheduleTargetsContents(definitions)),
  ])

  return { registryFile, targetsFile }
}

const scheduleNitroModule: NitroModule = {
  name: "@vitehub/schedule",
  async setup(nitro) {
    await assertNoVitePluginInNitro(nitro, SCHEDULE_VITE_PLUGIN_NAME, "@vitehub/schedule/nitro")

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/schedule"] = resolveRuntimeEntry("../index", "@vitehub/schedule")

    let runtimeFiles = await writeNitroScheduleRuntimeFiles(nitro)
    applyNitroRuntimeAliases(nitro, {
      "#vitehub/schedule/registry": runtimeFiles.registryFile,
      [SCHEDULE_TARGETS_ID]: runtimeFiles.targetsFile,
    })

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, SCHEDULE_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
    }

    hookNitroRuntimeRegistryRefresh(nitro, () => writeNitroScheduleRuntimeFiles(nitro), (nextRuntimeFiles) => {
      runtimeFiles = nextRuntimeFiles
      applyNitroRuntimeAliases(nitro, {
        "#vitehub/schedule/registry": runtimeFiles.registryFile,
        [SCHEDULE_TARGETS_ID]: runtimeFiles.targetsFile,
      })
    })
  },
}

export default scheduleNitroModule
