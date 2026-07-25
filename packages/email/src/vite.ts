import { resolve } from "node:path"

import { createNoExternalMerger, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { discoverEmailDefinition } from "./discovery.ts"

import type { DiscoveredEmailDefinition } from "./discovery.ts"
import type { Plugin, ResolvedConfig } from "vite"

export const EMAIL_DEFINITION_ID = "#vitehub/email/definition"
export const EMAIL_VITE_PLUGIN_NAME = "@vite-hub/email/vite"

const resolvedEmailDefinitionId = `\0${EMAIL_DEFINITION_ID}`
const mergeNoExternal = createNoExternalMerger("@vite-hub/email")

export interface EmailVitePluginOptions {
  projectRoot?: string
}

export interface EmailVitePluginAPI {
  getDefinition: () => DiscoveredEmailDefinition | undefined
  refresh: () => DiscoveredEmailDefinition | undefined
}

export type EmailVitePlugin = Plugin & { api: EmailVitePluginAPI }

function renderEmailDefinitionModule(definition: DiscoveredEmailDefinition | undefined): string {
  if (!definition) return "export const definition = undefined\nexport default definition\n"
  return [
    `import definition from ${JSON.stringify(definition.handler)}`,
    "export { definition }",
    "export default definition",
    "",
  ].join("\n")
}

function isEmailDefinitionFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/")
  return /\/?server\.email\.(?:c|m)?[jt]s$/i.test(normalized)
    || /\/server\/email\.(?:c|m)?[jt]s$/i.test(normalized)
}

export function hubEmail(options: EmailVitePluginOptions = {}): EmailVitePlugin {
  let resolved: ResolvedConfig | undefined
  let definition: DiscoveredEmailDefinition | undefined
  let serverDirs: string[] | undefined

  function refresh(): DiscoveredEmailDefinition | undefined {
    const viteRoot = resolve(resolved?.root ?? process.cwd())
    const projectRoot = resolveViteHubProjectRoot(viteRoot, { projectRoot: options.projectRoot })
    definition = discoverEmailDefinition(projectRoot, { serverDirs })
    return definition
  }

  return {
    name: EMAIL_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getDefinition: () => definition,
      refresh,
    },
    config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      return {
        ssr: { noExternal: mergeNoExternal(config.ssr?.noExternal) },
      }
    },
    configResolved(config) {
      resolved = config
      refresh()
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    handleHotUpdate(context) {
      const changed = context.file.replace(/\\/g, "/")
      const current = definition?.handler.replace(/\\/g, "/")
      if (changed !== current && !isEmailDefinitionFile(changed)) return

      resolved = context.server.config
      refresh()
      const module = context.server.moduleGraph.getModuleById(resolvedEmailDefinitionId)
      if (module) context.server.moduleGraph.invalidateModule(module)
    },
    resolveId(id) {
      if (id === EMAIL_DEFINITION_ID) return resolvedEmailDefinitionId
    },
    load(id) {
      if (id === resolvedEmailDefinitionId) return renderEmailDefinitionModule(definition)
    },
  }
}
