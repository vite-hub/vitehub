import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { applyNitroRuntimeAliases, createNitroRuntimeFilePath, hookNitroRuntimeRegistryRefresh, writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { detectHosting } from "@vite-hub/internal/feature-bridge/hosting"
import { assertNoVitePluginInNitro, mergeNitroImportsPreset, resolveRuntimeEntry as resolveEntry } from "@vite-hub/internal/nitro"

import { initializeWorkspaceAssetRegistry, syncWorkspaceBuildAssets, writeWorkspaceRuntimeRegistry } from "../../build/integration.ts"
import { normalizeWorkspaceOptions } from "../../config.ts"
import { discoverNitroWorkspaceDefinitions, type DiscoveredWorkspaceDefinition } from "../../build/discovery.ts"
import { createWorkspaceTypeAugmentation } from "../../build/generated-types.ts"
import { configureCloudflareArtifacts } from "../../integrations/cloudflare.ts"

import type { Nitro, NitroRuntimeConfig } from "nitro/types"
import type { ResolvedWorkspaceModuleOptions, WorkspaceModuleOptions } from "../../core/types.ts"

export interface WorkspaceNitroModule {
  name: string
  setup(this: void, nitro: unknown): void | Promise<void>
}

const WORKSPACE_NITRO_IMPORTS_PRESET = {
  from: "@vite-hub/workspace",
  imports: ["defineWorkspace", "useWorkspace"],
}
const WORKSPACE_VITE_PLUGIN_NAME = "@vite-hub/workspace/vite"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string) {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function resolveDependency(specifier: string) {
  return createRequire(import.meta.url).resolve(specifier)
}

function resolveShellDependency(specifier: string) {
  return createRequire(resolveDependency("@vite-hub/shell/package.json")).resolve(specifier)
}

function resolveShellTransitiveDependency(parentSpecifier: string, specifier: string) {
  return createRequire(resolveShellDependency(parentSpecifier)).resolve(specifier)
}

function resolveJustBashNestedDependency(parentSpecifier: string, specifier: string) {
  return createRequire(resolveShellTransitiveDependency("just-bash", parentSpecifier)).resolve(specifier)
}

function resolveIsomorphicGitDependency(specifier: string) {
  return createRequire(resolveDependency("isomorphic-git")).resolve(specifier)
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
  return `import type { ResolvedWorkspaceModuleOptions, WorkspaceModuleOptions } from "@vite-hub/workspace"

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
    `import { setWorkspaceHostedStoreLoader, setWorkspaceRuntimeAssetsRegistry, setWorkspaceRuntimeConfig, setWorkspaceRuntimeRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../runtime/state", "@vite-hub/workspace/internal/runtime/state")))}`,
  ]

  if (provider === "cloudflare-artifacts") {
    imports.push(`import { createCloudflareArtifactsWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../../providers/cloudflare/artifacts-store", "@vite-hub/workspace/internal/stores/cloudflare-artifacts")))}`)
  }
  else if (provider === "vercel-blob") {
    imports.push(`import { createVercelBlobWorkspaceStore } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../../providers/vercel/blob-store", "@vite-hub/workspace/internal/stores/vercel-blob")))}`)
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

export function workspaceNitro(options?: false | WorkspaceModuleOptions): WorkspaceNitroModule {
  return {
    name: "@vite-hub/workspace",
    async setup(nitroInput) {
      const nitro = nitroInput as Nitro
      await assertNoVitePluginInNitro(nitro, WORKSPACE_VITE_PLUGIN_NAME, "@vite-hub/workspace/nitro")

      const isDev = nitro.options.dev || process.env.VITEHUB_WORKSPACE_DEV === "true"
      const hosting = detectHosting(nitro)
      const configured = options ?? (nitro.options as typeof nitro.options & { workspace?: false | WorkspaceModuleOptions }).workspace
      const resolved = normalizeWorkspaceOptions(configured, {
      dev: isDev,
      env: process.env,
      hosting,
      rootDir: nitro.options.rootDir,
    })
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig) as NitroRuntimeConfig & Record<string, unknown>
    if (hosting) runtimeConfig.hosting ||= hosting
    runtimeConfig.workspace = resolved

    nitro.options.alias ||= {}
    nitro.options.alias["@vite-hub/workspace/internal/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vite-hub/workspace/internal/runtime/state")
    nitro.options.alias["@vite-hub/workspace/loader"] = resolveRuntimeEntry("../loader", "@vite-hub/workspace/loader")
    nitro.options.alias["@vite-hub/workspace/publish"] = resolveRuntimeEntry("../publish", "@vite-hub/workspace/publish")
    nitro.options.alias["@vite-hub/workspace/test"] = resolveRuntimeEntry("../test", "@vite-hub/workspace/test")
    nitro.options.alias["@vite-hub/workspace"] = resolveRuntimeEntry("../index", "@vite-hub/workspace")
    nitro.options.alias["isomorphic-git/http/web"] = resolveIsomorphicGitHttpWebEsmEntry()
    nitro.options.alias["isomorphic-git"] = resolveIsomorphicGitEsmEntry()
    for (const dependency of ["async-lock", "clean-git-ref", "crc-32", "diff3", "ignore", "inherits", "minimisted", "pako", "pify", "readable-stream", "sha.js/sha1.js", "simple-get"]) {
      nitro.options.alias[dependency] = resolveIsomorphicGitDependency(dependency)
    }
    for (const dependency of ["sprintf-js", "turndown"]) {
      nitro.options.alias[dependency] = resolveShellTransitiveDependency("just-bash", dependency)
    }
    nitro.options.alias["@mixmark-io/domino"] = resolveJustBashNestedDependency("turndown", "@mixmark-io/domino")

    let definitions = discoverNitroWorkspaceDefinitions(nitro.options.rootDir)
    const registryFile = await writeWorkspaceRuntimeRegistry(registryPath(nitro), definitions)
    const assetsRegistryFile = assetsRegistryPath(nitro)
    await initializeWorkspaceAssetRegistry(assetsRegistryFile, definitions, nitro.options.rootDir)
    const plugin = await writePlugin(nitro, registryFile, assetsRegistryFile, resolved)
    applyWorkspaceRuntimeAliases(nitro, registryFile, assetsRegistryFile)
    installNitroConfigTypes(nitro, () => definitions)

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, WORKSPACE_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
    }

    nitro.options.plugins ||= []
    if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.push(plugin)

    if (hosting.includes("cloudflare")) {
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

    nitro.logger.info(`@vite-hub/workspace enabled with ${definitions.length} workspace definition${definitions.length === 1 ? "" : "s"}`)
    },
  }
}

const workspaceNitroModule: WorkspaceNitroModule = workspaceNitro()

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
