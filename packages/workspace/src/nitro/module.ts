import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { createWorkspaceRegistryContents, discoverNitroWorkspaceDefinitions } from "../discovery.ts"
import { registerWorkspace } from "../registry.ts"
import { useWorkspace } from "../use.ts"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"
import type { ResolvedWorkspaceModuleOptions, WorkspaceDefinitionInput, WorkspaceModuleOptions } from "../types.ts"

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
    syncOnBuild: options?.syncOnBuild,
  }
}

function registryPath(nitro: Nitro) {
  return resolve(nitro.options.rootDir, ".vitehub/nitro-runtime/workspace/registry.mjs")
}

async function writeRegistry(nitro: Nitro) {
  const path = registryPath(nitro)
  const definitions = discoverNitroWorkspaceDefinitions(nitro.options.rootDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, createWorkspaceRegistryContents(path, definitions), "utf8")
  return { path, definitions }
}

function shouldSyncWorkspace(syncOnBuild: boolean | string[] | undefined, name: string) {
  return syncOnBuild === true || (Array.isArray(syncOnBuild) && syncOnBuild.includes(name))
}

async function syncBuildWorkspaces(nitro: Nitro, options: false | ResolvedWorkspaceModuleOptions) {
  if (!options || !options.syncOnBuild) return

  const definitions = discoverNitroWorkspaceDefinitions(nitro.options.rootDir)
  for (const definition of definitions) {
    if (!shouldSyncWorkspace(options.syncOnBuild, definition.name)) continue

    const mod = await import(pathToFileURL(definition.path).href) as { default?: WorkspaceDefinitionInput }
    if (!mod.default) throw new TypeError(`[vitehub] Workspace definition "${definition.name}" has no default export.`)

    registerWorkspace(definition.name, {
      ...mod.default,
      rootDir: mod.default.rootDir || nitro.options.rootDir,
    })

    const workspace = await useWorkspace(definition.name)
    await workspace.sync()
  }
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
      await syncBuildWorkspaces(nitro, resolved)
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
