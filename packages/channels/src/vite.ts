import { resolve } from "node:path"

import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import { discoverChannelDefinitions } from "./discovery.ts"

import type { DiscoveredChannelDefinition } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

export const CHANNELS_REGISTRY_ID = "#vitehub/channels/registry"
export const CHANNELS_RUNTIME_ID = "#vitehub/channels/runtime"
export const CHANNELS_VITE_PLUGIN_NAME = "@vite-hub/channels/vite"

const resolvedChannelsRegistryId = `\0${CHANNELS_REGISTRY_ID}`
const resolvedChannelsRuntimeId = `\0${CHANNELS_RUNTIME_ID}`
const mergeNoExternal = createNoExternalMerger("@vite-hub/channels")
const envVitePluginName = "@vite-hub/env/vite"

export interface ChannelsVitePluginOptions {
  projectRoot?: string
}

export interface ChannelsVitePluginAPI {
  getDefinitions: () => DiscoveredChannelDefinition[]
  refresh: () => DiscoveredChannelDefinition[]
}

export type ChannelsVitePlugin = Plugin & { api: ChannelsVitePluginAPI }

function renderRegistry(definitions: DiscoveredChannelDefinition[]): string {
  return [
    "const registry = {",
    ...definitions.map(definition => `  ${JSON.stringify(definition.name)}: () => import(${JSON.stringify(definition.handler)}),`),
    "}",
    "",
    "export default registry",
    "",
  ].join("\n")
}

function renderRuntimeModule(serverEnv: boolean): string {
  if (!serverEnv) return "export function resolveChannelRuntimeEnv() { return {} }\n"
  return [
    'import { useServerEnv } from "#vitehub/env/server"',
    "export function resolveChannelRuntimeEnv() { return useServerEnv() }",
    "",
  ].join("\n")
}

async function configureNitroChannels(
  config: Record<string, unknown>,
  projectRoot: string,
  definitions: DiscoveredChannelDefinition[],
): Promise<Record<string, unknown>> {
  const generatedDir = resolve(projectRoot, ".vitehub", "nitro", "channels")
  const registryFile = resolve(generatedDir, "registry.ts")
  const runtimeFile = resolve(generatedDir, "runtime.ts")
  await Promise.all([
    writeFileIfChanged(registryFile, renderRegistry(definitions)),
    writeFileIfChanged(runtimeFile, renderRuntimeModule(true)),
  ])
  const nitro = config.nitro && typeof config.nitro === "object" ? config.nitro as Record<string, unknown> : {}
  const alias = nitro.alias && typeof nitro.alias === "object" ? nitro.alias as Record<string, unknown> : {}
  return {
    ...nitro,
    alias: {
      ...alias,
      [CHANNELS_REGISTRY_ID]: registryFile,
      [CHANNELS_RUNTIME_ID]: runtimeFile,
    },
  }
}

function renderGeneratedTypes(definitions: DiscoveredChannelDefinition[], serverEnv: boolean): string {
  return [
    ...(serverEnv
      ? [
          'import type { ServerEnv } from "#vitehub/env/server"',
          "",
        ]
      : []),
    "declare global {",
    "  interface ViteHubChannelDefinitionModules {",
    ...definitions.map(definition =>
      `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)})`
    ),
    "  }",
    ...(serverEnv
      ? [
          "  namespace ViteHub {",
          "    interface ChannelRuntimeEnv extends ServerEnv {}",
          "  }",
        ]
      : []),
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

function isChannelDefinitionFile(file: string, projectRoot: string, serverDirs: string[] | undefined): boolean {
  const normalized = resolve(file).replace(/\\/g, "/")
  if (/\.channel\.(?:c|m)?[jt]s$/i.test(normalized)) return true
  return (serverDirs ?? [resolve(projectRoot, "server")]).some((directory) => {
    const channelDirectory = `${resolve(directory, "channels").replace(/\\/g, "/")}/`
    return normalized.startsWith(channelDirectory)
      && /\.(?:c|m)?[jt]s$/i.test(normalized.slice(channelDirectory.length))
  })
}

export function hubChannels(options: ChannelsVitePluginOptions = {}): ChannelsVitePlugin {
  let resolved: ResolvedConfig | undefined
  let definitions: DiscoveredChannelDefinition[] = []
  let serverDirs: string[] | undefined
  let projectRoot = process.cwd()
  let serverEnv = false

  function refresh(): DiscoveredChannelDefinition[] {
    const viteRoot = resolve(resolved?.root ?? process.cwd())
    projectRoot = resolveViteHubProjectRoot(viteRoot, { projectRoot: options.projectRoot })
    definitions = discoverChannelDefinitions({ rootDir: projectRoot, serverDirs })
    return definitions
  }

  async function refreshGeneratedTypes(): Promise<void> {
    await writeFileIfChanged(
      resolve(projectRoot, ".vitehub", "types", "channels.d.ts"),
      renderGeneratedTypes(definitions, serverEnv),
    )
  }

  return {
    name: CHANNELS_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getDefinitions: () => definitions,
      refresh,
    },
    async config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const nextConfig: Record<string, unknown> = {
        ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) },
      }
      if (hasNitroConfigContext(config)) {
        const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), { projectRoot: options.projectRoot })
        const nitroDefinitions = discoverChannelDefinitions({ rootDir: root, serverDirs })
        nextConfig.nitro = await configureNitroChannels(config as Record<string, unknown>, root, nitroDefinitions)
      }
      return nextConfig
    },
    async configResolved(config) {
      resolved = config
      serverEnv = config.plugins?.some(plugin => plugin.name === envVitePluginName) ?? false
      refresh()
      await refreshGeneratedTypes()
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async handleHotUpdate(context) {
      const changed = context.file.replace(/\\/g, "/")
      if (!isChannelDefinitionFile(changed, projectRoot, serverDirs)) return

      resolved = context.server.config
      refresh()
      await refreshGeneratedTypes()
      const module = context.server.moduleGraph.getModuleById(resolvedChannelsRegistryId)
      if (module) context.server.moduleGraph.invalidateModule(module)
    },
    resolveId(id) {
      if (id === CHANNELS_REGISTRY_ID) return resolvedChannelsRegistryId
      if (id === CHANNELS_RUNTIME_ID) return resolvedChannelsRuntimeId
    },
    load(id) {
      if (id === resolvedChannelsRegistryId) return renderRegistry(definitions)
      if (id === resolvedChannelsRuntimeId) return renderRuntimeModule(serverEnv)
    },
  }
}
