import { normalize, resolve } from "node:path"

import { shouldSkipViteProviderBuild } from "@vitehub/internal/build/deployment-output"
import { getViteMode } from "@vitehub/internal/build/mode"
import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"
import { createRuntimeRegistryContents } from "@vitehub/internal/definition-catalog"

import { discoverScheduleDefinitions } from "./discovery.ts"
import { generateProviderOutputs, schedulePackageName } from "./internal/provider-output.ts"
import scheduleNitroModule from "./nitro/module.ts"

import type { Plugin, ResolvedConfig } from "vite"

const SCHEDULE_VITE_PLUGIN_NAME = "@vitehub/schedule/vite"
const SCHEDULE_REGISTRY_ID = "#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_REGISTRY_ID = "\0#vitehub/schedule/registry"
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

  function createRegistryContents() {
    if (!resolved) {
      return createRuntimeRegistryContents(registryImportAnchor, [])
    }

    const definitions = discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: resolved.root,
    })

    return createRuntimeRegistryContents(resolve(resolved.root, registryImportAnchor), definitions)
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
      if (!/\.schedule\.(?:c|m)?[jt]s$/i.test(normalize(context.file))) {
        return
      }

      const registryModule = context.server.moduleGraph.getModuleById(RESOLVED_SCHEDULE_REGISTRY_ID)
      if (registryModule) {
        context.server.moduleGraph.invalidateModule(registryModule)
      }
    },
    resolveId(id) {
      if (id === SCHEDULE_REGISTRY_ID) {
        return RESOLVED_SCHEDULE_REGISTRY_ID
      }
    },
    load(id) {
      if (id === RESOLVED_SCHEDULE_REGISTRY_ID) {
        return createRegistryContents()
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
