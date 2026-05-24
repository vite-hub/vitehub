import { normalize } from "node:path"

import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { createScheduleRegistryContents, SCHEDULE_REGISTRY_ID } from "../generated/registry.ts"
import { createScheduleTargetsContents, SCHEDULE_TARGETS_ID } from "../generated/targets.ts"
import { discoverScheduleDefinitions } from "../internal/discovery.ts"
import scheduleNitroModule from "./nitro/module.ts"

import type { NitroModule } from "nitro/types"
import type { Plugin, ResolvedConfig } from "vite"

const schedulePackageName = "@vitehub/schedule"
const SCHEDULE_VITE_PLUGIN_NAME = "@vitehub/schedule/vite"
const RESOLVED_SCHEDULE_REGISTRY_ID = "\0#vitehub/schedule/registry"
const RESOLVED_SCHEDULE_TARGETS_ID = `\0${SCHEDULE_TARGETS_ID}`
const mergeNoExternal = createNoExternalMerger(schedulePackageName)

export type ScheduleVitePlugin = Plugin & { nitro: NitroModule }

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
    return createScheduleRegistryContents(SCHEDULE_REGISTRY_ID, definitions)
  }

  function createTargetsContents() {
    return createScheduleTargetsContents(discoverViteSchedules(), { types: true })
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
      if (!/\.(?:schedule|agent)\.(?:c|m)?[jt]s$/i.test(normalize(context.file))) {
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
  }
}
