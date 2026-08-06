import { resolve } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { createNoExternalMerger, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { discoverChannelDefinitions } from "./discovery.ts"

import type { DiscoveredChannelDefinition } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

export const CHANNELS_REGISTRY_ID = "#vitehub/channels/registry"
export const CHANNELS_VITE_PLUGIN_NAME = "@vite-hub/channels/vite"

const resolvedChannelsRegistryId = `\0${CHANNELS_REGISTRY_ID}`
const mergeNoExternal = createNoExternalMerger("@vite-hub/channels")

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

function renderRegistryTypes(definitions: DiscoveredChannelDefinition[]): string {
  return [
    "declare global {",
    "  interface ViteHubChannelDefinitionModules {",
    ...definitions.map(definition =>
      `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)})`
    ),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

function isChannelDefinitionFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/")
  return /\/server\/channels\/(?:[^/]+\/)*[^/]+\.(?:c|m)?[jt]s$/i.test(normalized)
    || /(?:^|\/)src\/.*\.channel\.(?:c|m)?[jt]s$/i.test(normalized)
    || /(?:^|\/)\.?[^/]*\.channel\.(?:c|m)?[jt]s$/i.test(normalized)
}

export function hubChannels(options: ChannelsVitePluginOptions = {}): ChannelsVitePlugin {
  let resolved: ResolvedConfig | undefined
  let definitions: DiscoveredChannelDefinition[] = []
  let serverDirs: string[] | undefined
  let projectRoot = process.cwd()

  function refresh(): DiscoveredChannelDefinition[] {
    const viteRoot = resolve(resolved?.root ?? process.cwd())
    projectRoot = resolveViteHubProjectRoot(viteRoot, { projectRoot: options.projectRoot })
    definitions = discoverChannelDefinitions({ rootDir: projectRoot, serverDirs })
    return definitions
  }

  async function refreshRegistryTypes(): Promise<void> {
    await writeFileIfChanged(
      resolve(projectRoot, ".vitehub", "types", "channels.d.ts"),
      renderRegistryTypes(definitions),
    )
  }

  return {
    name: CHANNELS_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getDefinitions: () => definitions,
      refresh,
    },
    config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      return {
        ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) },
      }
    },
    async configResolved(config) {
      resolved = config
      refresh()
      await refreshRegistryTypes()
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async handleHotUpdate(context) {
      const changed = context.file.replace(/\\/g, "/")
      if (!isChannelDefinitionFile(changed)) return

      resolved = context.server.config
      refresh()
      await refreshRegistryTypes()
      const module = context.server.moduleGraph.getModuleById(resolvedChannelsRegistryId)
      if (module) context.server.moduleGraph.invalidateModule(module)
    },
    resolveId(id) {
      if (id === CHANNELS_REGISTRY_ID) return resolvedChannelsRegistryId
    },
    load(id) {
      if (id === resolvedChannelsRegistryId) return renderRegistry(definitions)
    },
  }
}
