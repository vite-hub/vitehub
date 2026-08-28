import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { contributeProviderDeploymentOutput, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, getProviderRuntimeModule, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { collectViteHubProviderImportAliases, createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeHosting } from "@vite-hub/internal/hosting"

import { normalizeWorkflowOptions } from "./config.ts"
import { createCloudflareWorkflowNitroConfig, createOptionalViteDevtoolsPlugin, createVercelWorkflowTransformPlugin, generateWorkflowProviderOutputs, hasVercelNativeWorkflowEntry, workflowPackageName, writeProviderEntries } from "./internal/vite-build.ts"

import type { WorkflowModuleOptions } from "./types.ts"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin as EsbuildPlugin } from "esbuild"
import type { ViteHubProviderImportContributor } from "@vite-hub/internal/build/vite"
import type { Plugin, ResolvedConfig } from "vite"

interface WorkflowNitroConfigOptions {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}

export type WorkflowVitePlugin = Plugin & {
  vitehub?: {
    workflow?: {
      createNitroConfig?: (options: WorkflowNitroConfigOptions) => Promise<Record<string, unknown>>
      prepareScheduleRuntime?: (artifactDir?: string) => Promise<{
        bundleAlias: Record<string, string>
        bundlePlugins?: EsbuildPlugin[]
        importBase: string
        native: boolean
        registryFile: string
      } | undefined>
    }
  }
}

interface AgentWorkflowRegistryPlugin extends Plugin {
  vitehub?: {
    agent?: {
      transformWorkflowRegistry?: (code: string, id: string) => string | Promise<string>
    }
  }
}

const mergeNoExternal = createNoExternalMerger(workflowPackageName)

interface InternalWorkflowModuleOptions {
  agentImportBase?: string
  hosting?: string
  implicitlyEnabled?: boolean
  importBase?: string
  providerImportAliases?: Record<string, string>
  includeUserAppEntry?: boolean
  workspaceDependencyRuntimeImports?: {
    sandbox?: string
    sandboxRuntimeState?: string
    shellWorkspace?: string
  }
  workspaceImportBase?: string
}

function resolveStringAliases(config: ResolvedConfig): Record<string, string> {
  const aliases: Record<string, string> = {}
  for (const alias of config.resolve.alias) {
    if (typeof alias.find === "string" && typeof alias.replacement === "string") {
      aliases[alias.find] = alias.replacement
    }
  }
  return aliases
}

export function hubWorkflow(options?: WorkflowModuleOptions, internalOptions: InternalWorkflowModuleOptions = {}): WorkflowVitePlugin {
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let resolved: ResolvedConfig | undefined
  let workflow: WorkflowModuleOptions | undefined = internalOptions.implicitlyEnabled
    && normalizeHosting(internalOptions.hosting).includes("netlify")
    ? false
    : options
  let serverDirs: string[] | undefined
  const stagedArtifactDirs = new WeakMap<object, string>()
  const fallbackEnvironment = {}
  const buildEnvironment = (context: { environment?: object } | undefined): object =>
    context?.environment ?? context ?? fallbackEnvironment

  function providerRuntimeImportAliases(provider: "cloudflare" | "vercel"): Record<string, string> {
    const database = getProviderRuntimeModule(providerOutput, "database", provider)
    return database ? { "@vite-hub/database/drizzle": database } : {}
  }

  async function providerImportAliases(): Promise<Record<string, string>> {
    if (!resolved) return { ...internalOptions?.providerImportAliases }
    const contributedAliases = await collectViteHubProviderImportAliases(resolved.plugins as Array<Plugin & ViteHubProviderImportContributor>)
    return {
      ...resolveStringAliases(resolved),
      ...contributedAliases,
      ...internalOptions?.providerImportAliases,
    }
  }

  async function prepareScheduleRuntime(artifactDir?: string) {
    if (!resolved) throw new Error("[vitehub] Workflow runtime preparation requires resolved Vite config.")
    if (normalizeWorkflowOptions(workflow, { hosting: internalOptions?.hosting ?? "vercel" })?.provider !== "vercel") return
    const rootDir = resolveViteHubProjectRoot(resolved.root)
    const aliases = await providerImportAliases()
    const retainedSources = artifactDir
      ? await retainProviderOutputSources({
          artifactDir: resolve(artifactDir, "sources"),
          paths: Object.values(aliases),
          roots: [resolved.root],
        })
      : undefined
    const definitionRootDir = retainedSources?.resolve(resolved.root) ?? resolved.root
    const retainedServerDirs = serverDirs?.map(directory => retainedSources?.resolve(directory) ?? directory)
    const artifacts = await writeProviderEntries(rootDir, workflow, {
      agent: internalOptions?.agentImportBase,
      workflow: internalOptions?.importBase,
      workspace: internalOptions?.workspaceImportBase,
      workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
    }, retainedServerDirs, internalOptions?.includeUserAppEntry, (resolved.plugins as AgentWorkflowRegistryPlugin[])
      .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
      ?.vitehub?.agent?.transformWorkflowRegistry, definitionRootDir, artifactDir ? resolve(artifactDir, "output") : undefined)
    const importBase = internalOptions?.importBase ?? workflowPackageName
    const projectRequire = createRequire(resolve(resolved.root, "package.json"))
    const retainedAliases = Object.fromEntries(Object.entries(aliases)
      .map(([specifier, target]) => [specifier, retainedSources?.resolve(target) ?? target]))
    const native = hasVercelNativeWorkflowEntry(rootDir, artifacts.providerDefinitions, retainedAliases, artifacts.vercelNativeFiles)
    const workflowRequire = native ? createRequire(import.meta.url) : undefined
    const workflowApi = workflowRequire?.resolve("workflow/api")
    return {
      bundleAlias: {
        ...retainedAliases,
        [`${importBase}/runtime/state`]: projectRequire.resolve(`${importBase}/runtime/state`),
        [`${importBase}/runtime/vercel-vite`]: projectRequire.resolve(`${importBase}/runtime/vercel-vite`),
        ...(workflowApi && workflowRequire
          ? {
              "@workflow/core/runtime/world-target": createRequire(workflowRequire.resolve("@workflow/builders")).resolve("@workflow/world-vercel"),
              "workflow/api": workflowApi,
              "workflow/runtime": workflowRequire.resolve("workflow/runtime"),
            }
          : {}),
      },
      bundlePlugins: [
        createOptionalViteDevtoolsPlugin(rootDir),
        ...(native ? [await createVercelWorkflowTransformPlugin(rootDir)] : []),
      ].filter((plugin): plugin is EsbuildPlugin => Boolean(plugin)),
      importBase,
      native,
      registryFile: artifacts.registryFile,
    }
  }

  return {
    name: "@vite-hub/workflow/vite",
    config(config) {
      workflow = config.workflow ?? workflow
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
    },
    configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      workflow = config.workflow ?? workflow
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    vitehub: {
      workflow: {
        async createNitroConfig({ nitro, projectRoot, serverDirs: nitroServerDirs, transformRegistry }: WorkflowNitroConfigOptions) {
          return await createCloudflareWorkflowNitroConfig({
            agentImportBase: internalOptions?.agentImportBase,
            nitro,
            rootDir: projectRoot,
            serverDirs: nitroServerDirs,
            includeUserAppEntry: internalOptions?.includeUserAppEntry,
            workflow,
            workflowImportBase: internalOptions?.importBase,
            workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
            workspaceImportBase: internalOptions?.workspaceImportBase,
            transformRegistry,
          })
        },
        prepareScheduleRuntime,
      },
    },
    buildStart() {
      providerOutputGenerations.capture(this, providerOutput)
    },
    async buildEnd(error) {
      if (error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
        return
      }
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      const config = resolved
      const rootDir = resolveViteHubProjectRoot(config.root)
      // SAFETY: Vite plugin objects may expose ViteHub's optional agent extension, which the predicate reads defensively.
      const plugins = config.plugins as AgentWorkflowRegistryPlugin[]
      const generation = providerOutputGenerations.get(this)
      const environment = generation ?? buildEnvironment(this)
      const artifactDir = resolve(rootDir, ".vitehub/workflow-generations", randomUUID())
      const workflowOptions = workflow
      const workflowServerDirs = serverDirs
      const transformRegistry = plugins
        .find(plugin => plugin.vitehub?.agent?.transformWorkflowRegistry)
        ?.vitehub?.agent?.transformWorkflowRegistry
      try {
        const importAliases = await providerImportAliases()
        const runtimeImportAliases = {
          cloudflare: providerRuntimeImportAliases("cloudflare"),
          vercel: providerRuntimeImportAliases("vercel"),
        }
        const retainedSources = await retainProviderOutputSources({
          artifactDir: resolve(artifactDir, "sources"),
          paths: [
            ...Object.values(importAliases),
            ...Object.values(runtimeImportAliases.cloudflare),
            ...Object.values(runtimeImportAliases.vercel),
          ],
          roots: [config.root],
        })
        const retainedImportAliases = Object.fromEntries(Object.entries(importAliases)
          .map(([specifier, target]) => [specifier, retainedSources.resolve(target)]))
        const retainedRuntimeImportAliases = {
          cloudflare: Object.fromEntries(Object.entries(runtimeImportAliases.cloudflare)
            .map(([specifier, target]) => [specifier, retainedSources.resolve(target)])),
          vercel: Object.fromEntries(Object.entries(runtimeImportAliases.vercel)
            .map(([specifier, target]) => [specifier, retainedSources.resolve(target)])),
        }
        const retainedDefinitionRoot = retainedSources.resolve(config.root)
        const retainedServerDirs = workflowServerDirs?.map(directory => retainedSources.resolve(directory))
        const artifacts = await writeProviderEntries(rootDir, workflowOptions, {
          agent: internalOptions?.agentImportBase,
          workflow: internalOptions?.importBase,
          workspace: internalOptions?.workspaceImportBase,
          workspaceDependencies: internalOptions?.workspaceDependencyRuntimeImports,
        }, retainedServerDirs, internalOptions?.includeUserAppEntry, transformRegistry, retainedDefinitionRoot, resolve(artifactDir, "output"))
        stagedArtifactDirs.set(environment, artifactDir)
        contributeProviderDeploymentOutput(providerOutput, {
          discard: async () => {
            await rm(artifactDir, { force: true, recursive: true })
            if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
          },
          owner: "workflow",
          rootDir,
          write: async ({ write }) => {
            await generateWorkflowProviderOutputs({
              agentImportBase: internalOptions?.agentImportBase,
              artifacts,
              clientOutDir: resolve(config.root, config.build.outDir),
              hosting: internalOptions?.hosting,
              importBase: internalOptions?.importBase,
              providerImportAliases: retainedImportAliases,
              providerRuntimeImportAliases: retainedRuntimeImportAliases,
              rootDir,
              definitionRootDir: retainedDefinitionRoot,
              serverDirs: retainedServerDirs,
              serverFunctionName: resolveNitroVercelFunctionName(config, "workflow"),
              includeUserAppEntry: internalOptions?.includeUserAppEntry,
              workflow: workflowOptions,
              workspaceDependencyRuntimeImports: internalOptions?.workspaceDependencyRuntimeImports,
              workspaceImportBase: internalOptions?.workspaceImportBase,
              transformRegistry,
            }, write)
          },
        }, generation)
      }
      catch (error) {
        await rm(artifactDir, { force: true, recursive: true })
        if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
        await providerOutputGenerations.reset(this, providerOutput, error)
        throw error
      }
    },
    async renderError(error) {
      const environment = providerOutputGenerations.get(this) ?? buildEnvironment(this)
      await providerOutputGenerations.reset(this, providerOutput, error)
      const artifactDir = stagedArtifactDirs.get(environment)
      if (artifactDir) {
        await rm(artifactDir, { force: true, recursive: true })
        if (stagedArtifactDirs.get(environment) === artifactDir) stagedArtifactDirs.delete(environment)
      }
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    workflow?: WorkflowModuleOptions
  }
}
