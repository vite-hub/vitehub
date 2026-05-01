import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { createWorkspaceRegistryContents, discoverWorkspaceDefinitions } from "../discovery.ts"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"
import type { ResolvedWorkspaceModuleOptions, WorkspaceModuleOptions } from "../types.ts"

const WORKSPACE_NITRO_IMPORTS_PRESET = {
  from: "@vitehub/workspace",
  imports: ["defineWorkspace", "useWorkspace"],
}

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string) {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function normalizeWorkspaceOptions(options: false | WorkspaceModuleOptions | undefined, rootDir: string): false | ResolvedWorkspaceModuleOptions {
  if (options === false) return false
  return {
    root: resolve(rootDir, options?.root || ".vitehub/workspaces"),
  }
}

function registryPath(nitro: Nitro) {
  return resolve(nitro.options.rootDir, ".vitehub/nitro-runtime/workspace/registry.mjs")
}

async function writeRegistry(nitro: Nitro) {
  const path = registryPath(nitro)
  const definitions = discoverWorkspaceDefinitions(nitro.options.rootDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, createWorkspaceRegistryContents(definitions), "utf8")
  return { path, definitions }
}

const workspaceNitroModule: NitroModule = {
  name: "@vitehub/workspace",
  async setup(nitro) {
    const resolved = normalizeWorkspaceOptions((nitro.options as typeof nitro.options & { workspace?: false | WorkspaceModuleOptions }).workspace, nitro.options.rootDir)
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig) as NitroRuntimeConfig & Record<string, unknown>
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.workspace = resolved

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/workspace"] = resolveRuntimeEntry("../index", "@vitehub/workspace")
    nitro.options.alias["@vitehub/workspace/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vitehub/workspace/runtime/state")
    nitro.options.alias["@vitehub/workspace/runtime/nitro-plugin"] = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/workspace/runtime/nitro-plugin")

    const registry = await writeRegistry(nitro)
    nitro.options.alias["#vitehub-workspace-registry"] = registry.path

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, WORKSPACE_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
    }

    nitro.options.plugins ||= []
    const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/workspace/runtime/nitro-plugin")
    if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.push(plugin)

    nitro.hooks.hook("build:before", async () => {
      const next = await writeRegistry(nitro)
      nitro.options.alias ||= {}
      nitro.options.alias["#vitehub-workspace-registry"] = next.path
    })
    nitro.hooks.hook("dev:reload", async () => {
      const next = await writeRegistry(nitro)
      nitro.options.alias ||= {}
      nitro.options.alias["#vitehub-workspace-registry"] = next.path
    })

    nitro.logger.info(`@vitehub/workspace enabled with ${registry.definitions.length} workspace definition${registry.definitions.length === 1 ? "" : "s"}`)
  },
}

export default workspaceNitroModule

declare module "nitro/types" {
  interface NitroConfig {
    workspace?: false | WorkspaceModuleOptions
  }

  interface NitroOptions {
    workspace?: false | WorkspaceModuleOptions
  }

  interface NitroRuntimeConfig {
    hosting?: string
    workspace?: false | ResolvedWorkspaceModuleOptions
  }
}
