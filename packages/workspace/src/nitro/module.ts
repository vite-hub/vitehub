import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { createImportPath } from "@vitehub/internal/build/paths"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { normalizeWorkspaceOptions } from "../config.ts"
import { createWorkspaceRegistryContents, discoverNitroWorkspaceDefinitions } from "../discovery.ts"
import { configureCloudflareArtifacts } from "../integrations/cloudflare.ts"
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

function resolveDependency(specifier: string) {
  return createRequire(import.meta.url).resolve(specifier)
}

function resolveIsomorphicGitEsmEntry() {
  return resolve(dirname(resolveDependency("isomorphic-git")), "index.js")
}

function resolveIsomorphicGitHttpWebEsmEntry() {
  return resolve(dirname(resolveDependency("isomorphic-git/http/web")), "index.js")
}

function registryPath(nitro: Nitro) {
  return resolve(nitro.options.rootDir, ".vitehub/nitro-runtime/workspace/registry.mjs")
}

function pluginPath(nitro: Nitro) {
  return resolve(nitro.options.rootDir, ".vitehub/nitro-runtime/workspace/plugin.mjs")
}

function workspaceNitroConfigTypes() {
  return `import type { ResolvedWorkspaceModuleOptions, WorkspaceModuleOptions } from "@vitehub/workspace"

declare module "nitro/types" {
  interface NitroConfig {
    workspace?: false | WorkspaceModuleOptions
  }

  interface NitroOptions {
    workspace?: false | WorkspaceModuleOptions
    cloudflare?: { wrangler?: { artifacts?: Array<{ binding: string, namespace: string }> } }
  }

  interface NitroRuntimeConfig {
    hosting?: string
    workspace?: false | ResolvedWorkspaceModuleOptions
  }
}

declare module "nitropack/types" {
  interface NitroConfig {
    workspace?: false | WorkspaceModuleOptions
  }

  interface NitroOptions {
    workspace?: false | WorkspaceModuleOptions
    cloudflare?: { wrangler?: { artifacts?: Array<{ binding: string, namespace: string }> } }
  }

  interface NitroRuntimeConfig {
    hosting?: string
    workspace?: false | ResolvedWorkspaceModuleOptions
  }
}

export {}
`
}

function installNitroConfigTypes(nitro: Nitro) {
  nitro.hooks.hook("types:extend", async (types) => {
    const dtsPath = resolve(nitro.options.buildDir, "types", "vitehub-workspace-nitro.d.ts")
    await mkdir(dirname(dtsPath), { recursive: true })
    await writeFile(dtsPath, workspaceNitroConfigTypes(), "utf8")
    if (types.tsConfig) {
      types.tsConfig.include ||= []
      types.tsConfig.include.push(dtsPath)
    }
  })
}

async function writeRegistry(nitro: Nitro) {
  const path = registryPath(nitro)
  const definitions = discoverNitroWorkspaceDefinitions(nitro.options.rootDir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, createWorkspaceRegistryContents(path, definitions), "utf8")
  return { path, definitions }
}

function createNitroPluginContents(file: string, registryFile: string, options: false | ResolvedWorkspaceModuleOptions): string {
  const provider = options && options.store.provider
  const imports = [
    `import { definePlugin as defineNitroPlugin } from "nitro"`,
    `import { useRuntimeConfig } from "nitro/runtime-config"`,
    `import workspaceRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { setWorkspaceHostedStoreLoader, setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../runtime/state", "@vitehub/workspace/runtime/state")))}`,
  ]

  if (provider === "cloudflare-artifacts") {
    imports.push(`import { createCloudflareArtifactsWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../stores/cloudflare-artifacts", "@vitehub/workspace/stores/cloudflare-artifacts")))}`)
  }
  else if (provider === "vercel-blob") {
    imports.push(`import { createVercelBlobWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../stores/vercel-blob", "@vitehub/workspace/stores/vercel-blob")))}`)
  }

  const loader = provider === "cloudflare-artifacts"
    ? [
        "  setWorkspaceHostedStoreLoader((store, workspaceName) => {",
        "    if (store.provider !== 'cloudflare-artifacts') throw new Error(`[vitehub] Unsupported workspace store for Cloudflare build: ${store.provider}`)",
        "    return createCloudflareArtifactsWorkspaceStore(store, workspaceName)",
        "  })",
      ]
    : provider === "vercel-blob"
      ? [
          "  setWorkspaceHostedStoreLoader((store, workspaceName) => {",
          "    if (store.provider !== 'vercel-blob') throw new Error(`[vitehub] Unsupported workspace store for Vercel build: ${store.provider}`)",
          "    return createVercelBlobWorkspaceStore(store, workspaceName)",
          "  })",
        ]
      : ["  setWorkspaceHostedStoreLoader(undefined)"]

  return [
    ...imports,
    "",
    "export default defineNitroPlugin(() => {",
    "  const runtimeConfig = useRuntimeConfig()",
    "  setWorkspaceRuntimeConfig(runtimeConfig.workspace || false)",
    ...loader,
    "  setWorkspaceRuntimeRegistry(workspaceRegistry)",
    "})",
    "",
  ].join("\n")
}

async function writePlugin(nitro: Nitro, registryFile: string, options: false | ResolvedWorkspaceModuleOptions) {
  const path = pluginPath(nitro)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, createNitroPluginContents(path, registryFile, options), "utf8")
  return path
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
    const resolved = normalizeWorkspaceOptions((nitro.options as typeof nitro.options & { workspace?: false | WorkspaceModuleOptions }).workspace, {
      env: process.env,
      hosting: nitro.options.preset,
      rootDir: nitro.options.rootDir,
    })
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig) as NitroRuntimeConfig & Record<string, unknown>
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.workspace = resolved

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/workspace"] = resolveRuntimeEntry("../index", "@vitehub/workspace")
    nitro.options.alias["@vitehub/workspace/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vitehub/workspace/runtime/state")
    nitro.options.alias["isomorphic-git/http/web"] = resolveIsomorphicGitHttpWebEsmEntry()
    nitro.options.alias["isomorphic-git"] = resolveIsomorphicGitEsmEntry()
    for (const dependency of ["async-lock", "clean-git-ref", "crc-32", "diff3", "ignore", "inherits", "minimisted", "pako", "pify", "readable-stream", "sha.js/sha1.js", "simple-get"]) {
      nitro.options.alias[dependency] = resolveDependency(dependency)
    }

    const registry = await writeRegistry(nitro)
    const plugin = await writePlugin(nitro, registry.path, resolved)
    nitro.options.alias["#vitehub-workspace-registry"] = registry.path
    installNitroConfigTypes(nitro)

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, WORKSPACE_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
    }

    nitro.options.plugins ||= []
    if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.push(plugin)

    if (nitro.options.preset?.includes("cloudflare")) {
      configureCloudflareArtifacts(nitro.options, resolved)
    }

    nitro.hooks.hook("build:before", async () => {
      const next = await writeRegistry(nitro)
      await writePlugin(nitro, next.path, resolved)
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
    cloudflare?: { wrangler?: { artifacts?: Array<{ binding: string, namespace: string }> } }
  }

  interface NitroRuntimeConfig {
    hosting?: string
    workspace?: false | ResolvedWorkspaceModuleOptions
  }
}
