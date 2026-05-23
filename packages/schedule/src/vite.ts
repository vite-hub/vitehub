import { normalize } from "node:path"

import { createRuntimeRegistryContents } from "@vitehub/internal/definition-catalog"
import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { discoverScheduleDefinitions } from "./discovery.ts"
import scheduleNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin, ResolvedConfig } from "vite"

const schedulePackageName = "@vitehub/schedule"
const SCHEDULE_VITE_PLUGIN_NAME = "@vitehub/schedule/vite"
const SCHEDULE_REGISTRY_ID = "#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_REGISTRY_ID = "\0#vitehub/schedule/registry"
const mergeNoExternal = createNoExternalMerger(schedulePackageName)

export type ScheduleVitePlugin = Plugin & { nitro: NitroModule }

export function hubSchedule(): ScheduleVitePlugin {
  let resolved: ResolvedConfig | undefined

  function createRegistryContents() {
    if (!resolved) {
      return createRuntimeRegistryContents(SCHEDULE_REGISTRY_ID, [])
    }

    const definitions = discoverScheduleDefinitions({
      mode: "vite-suffix",
      rootDir: resolved.root,
    })

    return createRuntimeRegistryContents(SCHEDULE_REGISTRY_ID, definitions)
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
  }
}
