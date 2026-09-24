import { resolve } from "node:path"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

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
    "const registry = Object.create(null)",
    ...definitions.map(definition => `registry[${JSON.stringify(definition.name)}] = () => import(${JSON.stringify(definition.handler)})`),
    "",
    "export default registry",
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
  await writeFileIfChanged(registryFile, renderRegistry(definitions))
  const nitro = config.nitro && typeof config.nitro === "object" ? config.nitro as Record<string, unknown> : {}
  const alias = nitro.alias && typeof nitro.alias === "object" ? nitro.alias as Record<string, unknown> : {}
  const externals = nitro.externals && typeof nitro.externals === "object" ? nitro.externals as Record<string, unknown> : {}
  const existingInline = Array.isArray(externals.inline) ? externals.inline : []
  const inline = externals.inline === true
    ? true
    : [...new Set([...existingInline, "vite-hub", "@vite-hub/channels"])]
  return {
    ...nitro,
    alias: { ...alias, [CHANNELS_REGISTRY_ID]: registryFile },
    externals: { ...externals, inline },
  }
}

export function hubChannels(options: ChannelsVitePluginOptions = {}): ChannelsVitePlugin {
  let resolved: ResolvedConfig | undefined
  let definitions: DiscoveredChannelDefinition[] = []
  let serverDirs: string[] | undefined
  let projectRoot = process.cwd()
  let nitroRegistryFile: string | undefined

  function refresh(): DiscoveredChannelDefinition[] {
    const viteRoot = resolve(resolved?.root ?? process.cwd())
    projectRoot = resolveViteHubProjectRoot(viteRoot, { projectRoot: options.projectRoot })
    definitions = discoverAgentDefinitionEntries(projectRoot, serverDirs).map(definition => ({
      ...definition,
      source: "agent" as const,
    }))
    return definitions
  }

  async function refreshGeneratedFiles(): Promise<void> {
    if (nitroRegistryFile) await writeFileIfChanged(nitroRegistryFile, renderRegistry(definitions))
  }

  return {
    name: CHANNELS_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: { getDefinitions: () => definitions, refresh },
    async config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const nextConfig: Record<string, unknown> = {
        ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) },
      }
      if (hasNitroConfigContext(config)) {
        const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), { projectRoot: options.projectRoot })
        const nitroDefinitions = discoverAgentDefinitionEntries(root, serverDirs).map(definition => ({ ...definition, source: "agent" as const }))
        nextConfig.nitro = await configureNitroChannels(config as Record<string, unknown>, root, nitroDefinitions)
        nitroRegistryFile = resolve(root, ".vitehub", "nitro", "channels", "registry.ts")
      }
      return nextConfig
    },
    async configResolved(config) {
      resolved = config
      refresh()
      await refreshGeneratedFiles()
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return { resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) } }
    },
    async handleHotUpdate(context) {
      const changed = resolve(context.file)
      if (!/\.(?:c|m)?[jt]sx?$/.test(changed)) return
      const previous = definitions
      resolved = context.server.config
      refresh()
      if (!previous.some(definition => resolve(definition.handler) === changed)
        && JSON.stringify(previous) === JSON.stringify(definitions)) return
      await refreshGeneratedFiles()
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
