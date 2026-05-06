import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { applyNitroRuntimeAliases, createNitroRuntimeFilePath, hookNitroRuntimeRegistryRefresh, writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { initializeWorkspaceAssetRegistry, syncWorkspaceBuildAssets, writeWorkspaceRuntimeRegistry } from "../build-integration.ts"
import { normalizeWorkspaceOptions } from "../config.ts"
import { discoverNitroWorkspaceDefinitions, type DiscoveredWorkspaceDefinition } from "../discovery.ts"
import { createWorkspaceTypeAugmentation } from "../generated-types.ts"
import { configureCloudflareArtifacts } from "../integrations/cloudflare.ts"

import type { Nitro, NitroModule, NitroRuntimeConfig } from "nitro/types"
import type { ResolvedWorkspaceModuleOptions, WorkspaceModuleOptions } from "../types.ts"

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
  return createNitroRuntimeFilePath(nitro.options.rootDir, {
    fileName: "registry.mjs",
    segments: [".vitehub", "nitro-runtime", "workspace"],
  })
}

function pluginPath(nitro: Nitro) {
  return createNitroRuntimeFilePath(nitro.options.rootDir, {
    fileName: "plugin.mjs",
    segments: [".vitehub", "nitro-runtime", "workspace"],
  })
}

function assetsRegistryPath(nitro: Nitro) {
  return createNitroRuntimeFilePath(nitro.options.rootDir, {
    fileName: "assets/registry.mjs",
    segments: [".vitehub", "nitro-runtime", "workspace"],
  })
}

function workspaceNitroConfigTypes(definitions: DiscoveredWorkspaceDefinition[]) {
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

${createWorkspaceTypeAugmentation(definitions)}

export {}
`
}

function installNitroConfigTypes(nitro: Nitro, getDefinitions: () => DiscoveredWorkspaceDefinition[]) {
  nitro.hooks.hook("types:extend", async (types) => {
    const dtsPath = resolve(nitro.options.buildDir, "types", "vitehub-workspace-nitro.d.ts")
    await writeFileIfChanged(dtsPath, workspaceNitroConfigTypes(getDefinitions()))
    if (types.tsConfig) {
      types.tsConfig.include ||= []
      types.tsConfig.include.push(dtsPath)
    }
  })
}

function createNitroPluginContents(file: string, registryFile: string, assetsRegistryFile: string, options: false | ResolvedWorkspaceModuleOptions): string {
  const provider = options && options.store.provider
  const imports = [
    `import { definePlugin as defineNitroPlugin } from "nitro"`,
    `import { useRuntimeConfig } from "nitro/runtime-config"`,
    `import workspaceRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import workspaceAssetsRegistry from ${JSON.stringify(createImportPath(file, assetsRegistryFile))}`,
    `import { setWorkspaceHostedStoreLoader, setWorkspaceRuntimeAssetsRegistry, setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../runtime/state", "@vitehub/workspace/runtime/state")))}`,
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
    "  setWorkspaceRuntimeAssetsRegistry(workspaceAssetsRegistry)",
    "})",
    "",
  ].join("\n")
}

async function writePlugin(nitro: Nitro, registryFile: string, assetsRegistryFile: string, options: false | ResolvedWorkspaceModuleOptions) {
  const path = pluginPath(nitro)
  await writeFileIfChanged(path, createNitroPluginContents(path, registryFile, assetsRegistryFile, options))
  return path
}

function applyWorkspaceRuntimeAliases(nitro: Nitro, registryFile: string, assetsRegistryFile: string) {
  applyNitroRuntimeAliases(nitro, {
    "#vitehub-workspace-assets-registry": assetsRegistryFile,
    "#vitehub-workspace-registry": registryFile,
  })
}

const workspaceNitroModule: NitroModule = {
  name: "@vitehub/workspace",
  async setup(nitro) {
    const isDev = nitro.options.dev || process.env.VITEHUB_WORKSPACE_DEV === "true"
    const resolved = normalizeWorkspaceOptions((nitro.options as typeof nitro.options & { workspace?: false | WorkspaceModuleOptions }).workspace, {
      dev: isDev,
      env: process.env,
      hosting: nitro.options.preset,
      rootDir: nitro.options.rootDir,
    })
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig) as NitroRuntimeConfig & Record<string, unknown>
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.workspace = resolved

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/workspace/source"] = resolveRuntimeEntry("../source", "@vitehub/workspace/source")
    nitro.options.alias["@vitehub/workspace/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vitehub/workspace/runtime/state")
    nitro.options.alias["@vitehub/workspace"] = resolveRuntimeEntry("../index", "@vitehub/workspace")
    nitro.options.alias["isomorphic-git/http/web"] = resolveIsomorphicGitHttpWebEsmEntry()
    nitro.options.alias["isomorphic-git"] = resolveIsomorphicGitEsmEntry()
    for (const dependency of ["async-lock", "clean-git-ref", "crc-32", "diff3", "ignore", "inherits", "minimisted", "pako", "pify", "readable-stream", "sha.js/sha1.js", "simple-get"]) {
      nitro.options.alias[dependency] = resolveDependency(dependency)
    }

    let definitions = discoverNitroWorkspaceDefinitions(nitro.options.rootDir)
    const registryFile = await writeWorkspaceRuntimeRegistry(registryPath(nitro), definitions)
    const assetsRegistryFile = assetsRegistryPath(nitro)
    await initializeWorkspaceAssetRegistry(assetsRegistryFile)
    const plugin = await writePlugin(nitro, registryFile, assetsRegistryFile, resolved)
    applyWorkspaceRuntimeAliases(nitro, registryFile, assetsRegistryFile)
    installNitroConfigTypes(nitro, () => definitions)

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, WORKSPACE_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
    }

    nitro.options.plugins ||= []
    if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.push(plugin)

    if (nitro.options.preset?.includes("cloudflare")) {
      configureCloudflareArtifacts(nitro.options, resolved)
    }

    hookNitroRuntimeRegistryRefresh(nitro, async () => {
      definitions = discoverNitroWorkspaceDefinitions(nitro.options.rootDir)
      const nextPath = await writeWorkspaceRuntimeRegistry(registryPath(nitro), definitions)
      return { definitions, registryFile: nextPath }
    }, async (runtimeFiles, hookName) => {
      applyWorkspaceRuntimeAliases(nitro, runtimeFiles.registryFile, assetsRegistryFile)
      if (hookName === "build:before") {
        await syncWorkspaceBuildAssets(definitions, nitro.options.rootDir, resolved, assetsRegistryFile)
        await writePlugin(nitro, runtimeFiles.registryFile, assetsRegistryFile, resolved)
      }
    })

    nitro.logger.info(`@vitehub/workspace enabled with ${definitions.length} workspace definition${definitions.length === 1 ? "" : "s"}`)
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
