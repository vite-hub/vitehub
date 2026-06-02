import { normalize, resolve } from "node:path"

import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { getViteMode } from "@vite-hub/internal/build/mode"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { createNoExternalMerger, isServerEnvironment } from "@vite-hub/internal/build/vite"

import { discoverScheduleDefinitions } from "./discovery.ts"
import { generateProviderOutputs, schedulePackageName } from "./internal/provider-output.ts"
import scheduleNitroModule from "./nitro/module.ts"
import { createScheduleTargetsContents, SCHEDULE_TARGETS_ID } from "./targets-module.ts"

import type { Plugin, ResolvedConfig } from "vite"

const SCHEDULE_VITE_PLUGIN_NAME = "@vite-hub/schedule/vite"
const SCHEDULE_REGISTRY_ID = "#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_REGISTRY_ID = "\0#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_TARGETS_ID = `\0${SCHEDULE_TARGETS_ID}`
const registryImportAnchor = ".vitehub/schedule/registry.js"
const mergeNoExternal = createNoExternalMerger(schedulePackageName)

export type ScheduleVitePlugin = Plugin & { nitro: unknown }

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  const aliases: Record<string, string> = {}
  for (const alias of config.resolve.alias) {
    if (typeof alias.find === "string" && typeof alias.replacement === "string") {
      aliases[alias.find] = alias.replacement
    }
  }
  return aliases
}

export function hubSchedule(): ScheduleVitePlugin {
  let resolved: ResolvedConfig | undefined

  function discoverViteSchedules() {
    if (!resolved) {
      return []
    }

    return discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: resolved.root,
    })
  }

  function createRegistryContents() {
    const definitions = discoverViteSchedules()
    const registryImport = resolved ? resolve(resolved.root, registryImportAnchor) : registryImportAnchor
    return createRuntimeRegistryContents(registryImport, definitions)
  }

  function createTargetsContents() {
    return createScheduleTargetsContents(discoverViteSchedules(), { types: false })
  }

  return {
    name: SCHEDULE_VITE_PLUGIN_NAME,
    nitro: scheduleNitroModule,
    configResolved(config) {
      resolved = config
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    handleHotUpdate(context) {
      const file = normalize(context.file).replace(/\\/g, "/")
      if (!/\.schedule\.(?:c|m)?[jt]s$/i.test(file) && !/\/server\/schedules\/.*\.(?:c|m)?[jt]s$/i.test(file)) {
        return
      }

      const registryModule = context.server.moduleGraph.getModuleById(RESOLVED_SCHEDULE_REGISTRY_ID)
      if (registryModule) {
        context.server.moduleGraph.invalidateModule(registryModule)
      }
      const targetsModule = context.server.moduleGraph.getModuleById(RESOLVED_SCHEDULE_TARGETS_ID)
      if (targetsModule) {
        context.server.moduleGraph.invalidateModule(targetsModule)
      }
    },
    resolveId(id) {
      if (id === SCHEDULE_REGISTRY_ID) {
        return RESOLVED_SCHEDULE_REGISTRY_ID
      }
      if (id === SCHEDULE_TARGETS_ID) {
        return RESOLVED_SCHEDULE_TARGETS_ID
      }
    },
    load(id) {
      if (id === RESOLVED_SCHEDULE_REGISTRY_ID) {
        return createRegistryContents()
      }
      if (id === RESOLVED_SCHEDULE_TARGETS_ID) {
        return createTargetsContents()
      }
    },
    async closeBundle() {
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      await generateProviderOutputs({
        bundleAlias: resolveStringAliases(resolved),
        clientOutDir: resolved.build.outDir,
        rootDir: resolved.root,
      })
    },
  }
}
